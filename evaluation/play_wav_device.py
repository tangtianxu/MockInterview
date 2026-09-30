"""Play one PCM WAV on a named PortAudio output without changing Windows defaults."""

import argparse
import time
import wave

import numpy as np
import sounddevice as sd


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--device", type=int, required=True)
    args = parser.parse_args()

    with wave.open(args.path, "rb") as source:
        channels = source.getnchannels()
        sample_rate = source.getframerate()
        if source.getsampwidth() != 2:
            raise ValueError("Only 16-bit PCM WAV is supported")
        pcm = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
    audio = pcm.astype(np.float32).reshape(-1, channels) / 32768.0
    output_rate = int(sd.query_devices(args.device)["default_samplerate"])
    if output_rate != sample_rate:
        positions = np.arange(round(len(audio) * output_rate / sample_rate)) * sample_rate / output_rate
        input_positions = np.arange(len(audio))
        audio = np.column_stack(
            [np.interp(positions, input_positions, audio[:, channel]) for channel in range(channels)]
        ).astype(np.float32)
    expected_seconds = len(audio) / output_rate
    started = time.monotonic()
    sd.play(audio, samplerate=output_rate, device=args.device, blocking=True)
    if time.monotonic() - started < 0.8 * expected_seconds:
        raise RuntimeError("Playback stream stopped before the PCM duration elapsed")


if __name__ == "__main__":
    main()
