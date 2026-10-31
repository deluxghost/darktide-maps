"""Select compiled resources from the installed game with limn."""

import hashlib
import subprocess
from pathlib import Path

from ..formats.binary import resource_variants
from ..formats.resource import murmur64


class Resources:
    def __init__(self, game, limn, cache):
        self.game = Path(game).resolve()
        self.limn = Path(limn).resolve()
        self.cache = Path(cache).resolve()
        self.cache.mkdir(parents=True, exist_ok=True)

    def extract(self, kind, names):
        hashes = {murmur64(name) if isinstance(name, str) else name for name in names}
        directory = self.cache / kind
        directory.mkdir(exist_ok=True)
        extension = {"NavData": "23ee957dd4b1bb94"}.get(kind, kind)
        paths = {key: directory / f"{key:016x}.{extension}" for key in hashes}
        missing = [key for key, path in paths.items() if not path.exists()]
        if missing:
            selection = directory / "selection.txt"
            selection.write_text("".join(f"@{key:016x}={key:016x}\n" for key in sorted(missing)), encoding="utf-8")
            print(f"Extracting {len(missing)} {kind} resources", flush=True)
            subprocess.run([str(self.limn), "-i", str(self.game / "bundle"),
                            "-o", str(directory), "--dict", str(selection),
                            "--dump-raw", kind], check=True)
        absent = [str(path) for path in paths.values() if not path.exists()]
        if absent:
            raise FileNotFoundError("Resources not extracted:\n" + "\n".join(absent))
        for key, path in paths.items():
            actual, _ = resource_variants(path, murmur64(kind))
            if actual != key:
                raise ValueError(f"{path}: resource name hash mismatch")
        return paths

    def lua_sources(self, names, decompiler):
        names = sorted(set(names))
        bytecode = self.cache / "lua-bytecode"
        source = self.cache / "lua-source"
        bytecode.mkdir(exist_ok=True)
        source.mkdir(exist_ok=True)
        missing = [name for name in names if not (bytecode / f"{name}.lua").is_file()]
        if missing:
            selection = self.cache / "lua-selection.txt"
            selection.write_text("\n".join(missing) + "\n", encoding="utf-8")
            subprocess.run([str(self.limn), "-i", str(self.game / "bundle"),
                            "-o", str(bytecode), "--dict", str(selection), "lua"], check=True)
        for name in names:
            if not (bytecode / f"{name}.lua").is_file():
                raise FileNotFoundError(f"Lua resource not extracted: {name}")
        if missing or any(not (source / f"{name}.lua").is_file() for name in names):
            subprocess.run([str(decompiler), str(bytecode), "-e", "lua", "-o", str(source), "-s", "-f"], check=True)
        paths = {name: source / f"{name}.lua" for name in names}
        for name, path in paths.items():
            if not path.is_file() or path.stat().st_size == 0:
                raise FileNotFoundError(f"Lua resource not decompiled: {name}")
        return paths


def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()
