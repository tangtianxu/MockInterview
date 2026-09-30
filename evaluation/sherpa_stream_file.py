"""Replay a 16 kHz WAV through the same sherpa-onnx C API/config as the app.

Usage: python evaluation/sherpa_stream_file.py zipformer|paraformer input.wav
"""

import ctypes as C
import json
import sys
import time
import wave
from pathlib import Path


class Transducer(C.Structure):
    _fields_ = [(name, C.c_char_p) for name in ("encoder", "decoder", "joiner")]


class Paraformer(C.Structure):
    _fields_ = [(name, C.c_char_p) for name in ("encoder", "decoder")]


class SingleModel(C.Structure):
    _fields_ = [("model", C.c_char_p)]


class ModelConfig(C.Structure):
    _fields_ = [
        ("transducer", Transducer), ("paraformer", Paraformer),
        ("zipformer2_ctc", SingleModel), ("tokens", C.c_char_p),
        ("num_threads", C.c_int32), ("provider", C.c_char_p),
        ("debug", C.c_int32), ("model_type", C.c_char_p),
        ("modeling_unit", C.c_char_p), ("bpe_vocab", C.c_char_p),
        ("tokens_buf", C.c_char_p), ("tokens_buf_size", C.c_int32),
        ("nemo_ctc", SingleModel), ("t_one_ctc", SingleModel),
    ]


class FeatureConfig(C.Structure):
    _fields_ = [("sample_rate", C.c_int32), ("feature_dim", C.c_int32)]


class CtcFst(C.Structure):
    _fields_ = [("graph", C.c_char_p), ("max_active", C.c_int32)]


class Homophone(C.Structure):
    _fields_ = [(name, C.c_char_p) for name in ("dict_dir", "lexicon", "rule_fsts")]


class RecognizerConfig(C.Structure):
    _fields_ = [
        ("feat_config", FeatureConfig), ("model_config", ModelConfig),
        ("decoding_method", C.c_char_p), ("max_active_paths", C.c_int32),
        ("enable_endpoint", C.c_int32), ("rule1_min_trailing_silence", C.c_float),
        ("rule2_min_trailing_silence", C.c_float), ("rule3_min_utterance_length", C.c_float),
        ("hotwords_file", C.c_char_p), ("hotwords_score", C.c_float),
        ("ctc_fst_decoder_config", CtcFst), ("rule_fsts", C.c_char_p),
        ("rule_fars", C.c_char_p), ("blank_penalty", C.c_float),
        ("hotwords_buf", C.c_char_p), ("hotwords_buf_size", C.c_int32),
        ("hr", Homophone),
    ]


class Result(C.Structure):
    _fields_ = [("text", C.c_char_p)]


def main() -> None:
    family, wav_path = sys.argv[1:3]
    root = Path(r"E:\models\sherpa_bilingual")
    model = root / (
        "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
        if family == "zipformer" else "sherpa-onnx-streaming-paraformer-bilingual-zh-en"
    )
    dll = C.CDLL(r"E:\Apps\面试即答\sherpa-onnx\sherpa-onnx-c-api.dll")
    dll.SherpaOnnxCreateOnlineRecognizer.argtypes = [C.POINTER(RecognizerConfig)]
    dll.SherpaOnnxCreateOnlineRecognizer.restype = C.c_void_p
    dll.SherpaOnnxDestroyOnlineRecognizer.argtypes = [C.c_void_p]
    dll.SherpaOnnxCreateOnlineStream.argtypes = [C.c_void_p]
    dll.SherpaOnnxCreateOnlineStream.restype = C.c_void_p
    dll.SherpaOnnxDestroyOnlineStream.argtypes = [C.c_void_p]
    dll.SherpaOnnxOnlineStreamAcceptWaveform.argtypes = [C.c_void_p, C.c_int32, C.POINTER(C.c_float), C.c_int32]
    dll.SherpaOnnxIsOnlineStreamReady.argtypes = [C.c_void_p, C.c_void_p]
    dll.SherpaOnnxIsOnlineStreamReady.restype = C.c_int32
    dll.SherpaOnnxDecodeOnlineStream.argtypes = [C.c_void_p, C.c_void_p]
    dll.SherpaOnnxGetOnlineStreamResult.argtypes = [C.c_void_p, C.c_void_p]
    dll.SherpaOnnxGetOnlineStreamResult.restype = C.POINTER(Result)
    dll.SherpaOnnxDestroyOnlineRecognizerResult.argtypes = [C.POINTER(Result)]
    dll.SherpaOnnxOnlineStreamIsEndpoint.argtypes = [C.c_void_p, C.c_void_p]
    dll.SherpaOnnxOnlineStreamIsEndpoint.restype = C.c_int32
    dll.SherpaOnnxOnlineStreamReset.argtypes = [C.c_void_p, C.c_void_p]
    dll.SherpaOnnxOnlineStreamInputFinished.argtypes = [C.c_void_p]

    def p(path: Path) -> bytes:
        return str(path).encode("utf-8")

    config = RecognizerConfig()
    config.feat_config = FeatureConfig(16_000, 80)
    config.model_config.tokens = p(model / "tokens.txt")
    config.model_config.num_threads = 2
    config.model_config.provider = b"cpu"
    config.model_config.model_type = family.encode()
    if family == "zipformer":
        config.model_config.transducer = Transducer(
            p(model / "encoder-epoch-99-avg-1.int8.onnx"),
            p(model / "decoder-epoch-99-avg-1.onnx"),
            p(model / "joiner-epoch-99-avg-1.int8.onnx"),
        )
    else:
        config.model_config.paraformer = Paraformer(
            p(model / "encoder.int8.onnx"), p(model / "decoder.int8.onnx")
        )
    config.decoding_method = b"greedy_search"
    config.enable_endpoint = 1
    config.rule1_min_trailing_silence = 2.0
    config.rule2_min_trailing_silence = 1.2
    config.rule3_min_utterance_length = 20.0

    with wave.open(wav_path, "rb") as reader:
        if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate()) != (1, 2, 16_000):
            raise ValueError("expected mono 16 kHz PCM16 WAV")
        pcm = reader.readframes(reader.getnframes())
    import array
    pcm16 = array.array("h")
    pcm16.frombytes(pcm)
    started = time.perf_counter()
    recognizer = dll.SherpaOnnxCreateOnlineRecognizer(C.byref(config))
    if not recognizer:
        raise RuntimeError("recognizer did not load")
    loaded_ms = round((time.perf_counter() - started) * 1000)
    stream = dll.SherpaOnnxCreateOnlineStream(recognizer)
    if not stream:
        dll.SherpaOnnxDestroyOnlineRecognizer(recognizer)
        raise RuntimeError("stream did not start")
    partials = []
    finals = []
    prior = ""

    def read_result() -> str:
        result = dll.SherpaOnnxGetOnlineStreamResult(recognizer, stream)
        try:
            return result.contents.text.decode("utf-8").strip() if result and result.contents.text else ""
        finally:
            if result:
                dll.SherpaOnnxDestroyOnlineRecognizerResult(result)

    try:
        for offset in range(0, len(pcm16), 8_000):
            part = pcm16[offset:offset + 8_000]
            samples = (C.c_float * len(part))(*(value / 32768 for value in part))
            dll.SherpaOnnxOnlineStreamAcceptWaveform(stream, 16_000, samples, len(part))
            while dll.SherpaOnnxIsOnlineStreamReady(recognizer, stream):
                dll.SherpaOnnxDecodeOnlineStream(recognizer, stream)
            current = read_result()
            audio_s = round((offset + len(part)) / 16_000, 2)
            if current and current != prior:
                prior = current
                partials.append({"audio_s": audio_s, "text": current})
            if dll.SherpaOnnxOnlineStreamIsEndpoint(recognizer, stream):
                if prior:
                    finals.append({"audio_s": audio_s, "text": prior})
                dll.SherpaOnnxOnlineStreamReset(recognizer, stream)
                prior = ""
        dll.SherpaOnnxOnlineStreamInputFinished(stream)
        while dll.SherpaOnnxIsOnlineStreamReady(recognizer, stream):
            dll.SherpaOnnxDecodeOnlineStream(recognizer, stream)
        ending = read_result()
        if ending:
            finals.append({"audio_s": round(len(pcm16) / 16_000, 2), "text": ending})
    finally:
        dll.SherpaOnnxDestroyOnlineStream(stream)
        dll.SherpaOnnxDestroyOnlineRecognizer(recognizer)
    print(json.dumps({
        "model": family, "load_ms": loaded_ms,
        "inference_ms": round((time.perf_counter() - started) * 1000) - loaded_ms,
        "first_partial_audio_s": partials[0]["audio_s"] if partials else None,
        "first_partial_text": partials[0]["text"] if partials else None,
        "partial_updates": len(partials), "partials": partials, "finals": finals,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
