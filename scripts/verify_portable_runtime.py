"""Reject CUDA DLL imports in the executable and bundled speech runtimes."""
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CUDA_DLL = re.compile(r'^(?:cublas|cudart|cufft|curand|cusolver|cusparse|nvrtc|nvjitlink|nvcuda|ggml-cuda)', re.I)


def dll_imports(path):
    data = Path(path).read_bytes()
    def u16(offset):
        return struct.unpack_from('<H', data, offset)[0]
    def u32(offset):
        return struct.unpack_from('<I', data, offset)[0]
    def u64(offset):
        return struct.unpack_from('<Q', data, offset)[0]
    if data[:2] != b'MZ':
        raise ValueError(f'{path}: not a Windows executable')
    pe = u32(0x3c)
    if data[pe:pe+4] != b'PE\0\0':
        raise ValueError(f'{path}: invalid PE header')
    optional = pe + 24
    magic = u16(optional)
    if magic not in (0x10b, 0x20b):
        raise ValueError(f'{path}: unsupported PE optional header')
    pe64 = magic == 0x20b
    directories = optional + (112 if pe64 else 96)
    image_base = u64(optional+24) if pe64 else u32(optional+28)
    section_table = optional + u16(pe+20)
    sections = []
    for index in range(u16(pe+6)):
        section = section_table + index*40
        sections.append((u32(section+12), max(u32(section+8), u32(section+16)), u32(section+20)))
    def offset(rva):
        if rva < u32(optional+60):
            return rva
        for start, size, raw in sections:
            if start <= rva < start+size:
                return raw+rva-start
        raise ValueError(f'{path}: unmapped import address')
    def name(rva):
        start = offset(rva)
        return data[start:data.index(b'\0', start)].decode('ascii')
    result = set()
    # Ordinary imports and delay imports both need inspection. Delay descriptors
    # normally use RVAs; older PE32 files can store virtual addresses instead.
    for directory, stride, name_field in ((1, 20, 12), (13, 32, 4)):
        rva, size = struct.unpack_from('<II', data, directories+directory*8)
        if not rva:
            continue
        start = offset(rva)
        for position in range(start, start+size, stride):
            if not any(data[position:position+stride]):
                break
            name_rva = u32(position+name_field)
            if directory == 13 and not (u32(position) & 1):
                name_rva -= image_base
            result.add(name(name_rva))
    return result


def verify_portable(executable):
    files = [Path(executable), *sorted((ROOT/'src-tauri/resources/sherpa-onnx').glob('*.dll'))]
    for file in files:
        forbidden = sorted(dll for dll in dll_imports(file) if CUDA_DLL.match(dll))
        if forbidden:
            raise ValueError(f'{file.name}: CUDA startup dependency: {", ".join(forbidden)}')
    print(f'Portable runtime verified: {len(files)} Windows binaries; no CUDA DLL imports')


if __name__ == '__main__':
    verify_portable(sys.argv[1])
