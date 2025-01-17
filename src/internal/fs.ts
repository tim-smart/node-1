import * as Effect from "@effect/io/Effect"
import { effectify } from "@effect/node/internal/effectify"
import * as Sink from "@effect/stream/Sink"
import * as Stream from "@effect/stream/Stream"
import { pipe } from "@fp-ts/core/Function"
import * as Option from "@fp-ts/core/Option"
import type { Mode, ObjectEncodingOptions } from "node:fs"
import * as NFS from "node:fs"
import { ErrnoError } from "./error"

export const DEFAULT_CHUNK_SIZE = 512 * 1024

export class FsOpenError {
  readonly _tag = "FsOpenError"
  constructor(readonly error: unknown) {}
}

export class Fd {
  readonly _tag = "Fd"
  constructor(readonly fd: number) {}
}

const errnoWrap = (_: NodeJS.ErrnoException) => new ErrnoError(_)

const unsafeOpen = effectify(NFS.open, errnoWrap, (_) => new FsOpenError(_))
const close = effectify(NFS.close, (_) => new ErrnoError(_ as any))

export const open = (path: string, flags?: NFS.OpenMode, mode?: NFS.Mode) =>
  pipe(
    Effect.acquireRelease(unsafeOpen(path, flags, mode), (fd) => Effect.ignoreLogged(close(fd))),
    Effect.map((_) => new Fd(_))
  )

export class FsStatError {
  readonly _tag = "FsStatError"
  constructor(readonly error: unknown) {}
}

export const stat = effectify(NFS.stat, errnoWrap, (_) => new FsStatError(_))

export class FsReaddirError {
  readonly _tag = "FsReaddirError"
  constructor(readonly error: unknown) {}
}
export const readdir = effectify(NFS.readdir, errnoWrap, (_) => new FsReaddirError(_))

export class FsReadFileError {
  readonly _tag = "FsReadFileError"
  constructor(readonly error: unknown) {}
}

export const readFile: {
  (path: NFS.PathOrFileDescriptor, options?: {
    flag?: string
  }): Effect.Effect<never, ErrnoError | FsReadFileError, Buffer>
  (path: NFS.PathOrFileDescriptor, options: {
    encoding: BufferEncoding
    flag?: string
  }): Effect.Effect<never, ErrnoError | FsReadFileError, string>
} = (path, options) =>
  Effect.asyncInterrupt<never, ErrnoError | FsReadFileError, Buffer | string>((resume) => {
    const controller = new AbortController()

    try {
      NFS.readFile(path, {
        ...(options || {}),
        signal: controller.signal
      }, (err, data) => {
        if (err) {
          resume(Effect.fail(new ErrnoError(err)))
        } else {
          resume(Effect.succeed(data))
        }
      })
    } catch (err) {
      resume(Effect.fail(new FsReadFileError(err)))
    }

    return Effect.sync(() => {
      controller.abort()
    })
  }) as any

export class FsWriteFileError {
  readonly _tag = "FsWriteFileError"
  constructor(readonly error: unknown) {}
}

export const writeFile = (
  path: NFS.PathOrFileDescriptor,
  data: string | NodeJS.ArrayBufferView,
  options?: (
    & ObjectEncodingOptions
    & {
      mode?: Mode
      flag?: string
    }
  )
) =>
  Effect.asyncInterrupt<never, ErrnoError | FsWriteFileError, void>((resume) => {
    const controller = new AbortController()

    try {
      NFS.writeFile(path, data, {
        ...(options || {}),
        signal: controller.signal
      }, (err) => {
        if (err) {
          resume(Effect.fail(new ErrnoError(err)))
        } else {
          resume(Effect.unit())
        }
      })
    } catch (err) {
      resume(Effect.fail(new FsWriteFileError(err)))
    }

    return Effect.sync(() => {
      controller.abort()
    })
  }) as any

export class FsCopyFileError {
  readonly _tag = "FsCopyFileError"
  constructor(readonly error: unknown) {}
}

export const copyFile = effectify(NFS.copyFile, errnoWrap, (_) => new FsCopyFileError(_))

export const read = (
  fd: Fd,
  buf: Uint8Array,
  offset: number,
  length: number,
  position: NFS.ReadPosition | null
) =>
  Effect.async<never, ErrnoError, number>((resume) => {
    NFS.read(fd.fd, buf, offset, length, position, (err, bytesRead) => {
      if (err) {
        resume(Effect.fail(new ErrnoError(err)))
      } else {
        resume(Effect.succeed(bytesRead))
      }
    })
  })

export const allocAndRead = (fd: Fd, size: number, position: NFS.ReadPosition | null) =>
  pipe(
    Effect.sync(() => Buffer.allocUnsafeSlow(size)),
    Effect.flatMap((buf) =>
      pipe(
        read(fd, buf, 0, size, position),
        Effect.map((bytesRead) => {
          if (bytesRead === 0) {
            return Option.none()
          }

          if (bytesRead === size) {
            return Option.some([buf, bytesRead] as const)
          }

          const dst = Buffer.allocUnsafeSlow(bytesRead)
          buf.copy(dst, 0, 0, bytesRead)
          return Option.some([dst, bytesRead] as const)
        })
      )
    )
  )

export interface StreamOptions {
  bufferSize?: number
  chunkSize?: number
  offset?: number
  bytesToRead?: number
}

export const stream = (
  path: string,
  {
    bufferSize = 4,
    chunkSize = DEFAULT_CHUNK_SIZE,
    offset = 0,
    bytesToRead
  }: StreamOptions = {}
) =>
  pipe(
    open(path, "r"),
    Effect.map((fd) =>
      Stream.unfoldEffect(offset, (position) => {
        if (bytesToRead !== undefined && bytesToRead <= position - offset) {
          return Effect.succeedNone()
        }

        const toRead = bytesToRead !== undefined && bytesToRead - (position - offset) < chunkSize
          ? bytesToRead - (position - offset)
          : chunkSize

        return pipe(
          allocAndRead(fd, toRead, position),
          Effect.map(
            Option.map(([buf, bytesRead]) => [buf, position + bytesRead] as const)
          )
        )
      })
    ),
    Stream.unwrapScoped,
    Stream.bufferChunks(bufferSize)
  )

export const write = (fd: Fd, data: Uint8Array, offset?: number) =>
  Effect.async<never, ErrnoError, number>((resume) => {
    NFS.write(fd.fd, data, offset, (err, written) => {
      if (err) {
        resume(Effect.fail(new ErrnoError(err)))
      } else {
        resume(Effect.succeed(written))
      }
    })
  })

export const writeAll = (
  fd: Fd,
  data: Uint8Array,
  offset = 0
): Effect.Effect<never, ErrnoError, void> =>
  pipe(
    write(fd, data, offset),
    Effect.flatMap((bytesWritten) => {
      const newOffset = offset + bytesWritten

      if (newOffset >= data.byteLength) {
        return Effect.unit()
      }

      return writeAll(fd, data, newOffset)
    })
  )

export const sink = (path: string, flags: NFS.OpenMode = "w", mode?: NFS.Mode) =>
  pipe(
    open(path, flags, mode),
    Effect.map((fd) => Sink.forEach((_: Uint8Array) => writeAll(fd, _))),
    Sink.unwrapScoped
  )
