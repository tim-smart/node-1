import * as Effect from "@effect/io/Effect"
import * as Sink from "@effect/stream/Sink"
import * as Stream from "@effect/stream/Stream"
import type { LazyArg } from "@fp-ts/core/Function"
import { pipe } from "@fp-ts/core/Function"
import * as Option from "@fp-ts/core/Option"
import type { Readable, Writable } from "node:stream"

export const DEFAULT_CHUNK_SIZE = 64 * 1024

export class ReadableError {
  readonly _tag = "ReadableError"
  constructor(readonly error: Error) {}
}

export class WritableError {
  readonly _tag = "WritableError"
  constructor(readonly error: Error) {}
}

export interface StreamOptions {
  chunkSize?: number
}

export type ReadableStream<A> = Stream.Stream<never, ReadableError, A>

export const stream = <A>(
  evaluate: LazyArg<Readable>,
  { chunkSize = DEFAULT_CHUNK_SIZE }: StreamOptions = {}
): ReadableStream<A> =>
  pipe(
    Effect.acquireRelease(Effect.sync(evaluate), (stream) =>
      Effect.sync(() => {
        stream.removeAllListeners()

        if (!stream.closed) {
          stream.destroy()
        }
      })),
    Effect.map((stream) =>
      Stream.async<never, ReadableError, Readable>((emit) => {
        stream.once("error", (err) => {
          emit.fail(new ReadableError(err))
        })

        stream.once("end", () => {
          emit.end()
        })

        stream.on("readable", () => {
          emit.single(stream)
        })

        if (stream.readable) {
          emit.single(stream)
        }
      }, 0)
    ),
    Stream.unwrapScoped,
    Stream.flatMap((_) => Stream.repeatEffectOption(readChunk<A>(_, chunkSize)))
  )

const readChunk = <A>(
  stream: Readable,
  size: number
): Effect.Effect<never, Option.Option<never>, A> =>
  pipe(
    Effect.sync(() => stream.read(size) as A | null),
    Effect.flatMap((a) => (a ? Effect.succeed(a) : Effect.fail(Option.none())))
  )

export interface SinkOptions {
  endOnExit?: boolean
  encoding?: BufferEncoding
}

export type WritableSink<A> = Sink.Sink<never, WritableError, A, never, void>

export const sink = <A>(
  evaluate: LazyArg<Writable>,
  { encoding = "binary", endOnExit = true }: SinkOptions = {}
): WritableSink<A> =>
  pipe(
    Effect.acquireRelease(Effect.sync(evaluate), endOnExit ? end : () => Effect.unit()),
    Effect.map((_) => makeSink<A>(_, encoding)),
    Sink.unwrapScoped
  )

const end = (stream: Writable) =>
  Effect.async<never, never, void>((resume) => {
    if (stream.closed) {
      resume(Effect.unit())
      return
    }

    stream.end(() => resume(Effect.unit()))
  })

const makeSink = <A>(stream: Writable, encoding: BufferEncoding) => Sink.forEach(write<A>(stream, encoding))

const write = <A>(stream: Writable, encoding: BufferEncoding) =>
  (_: A) =>
    Effect.async<never, WritableError, void>((resume) => {
      stream.write(_, encoding, (err) => {
        if (err) {
          resume(Effect.fail(new WritableError(err)))
        } else {
          resume(Effect.unit())
        }
      })
    })
