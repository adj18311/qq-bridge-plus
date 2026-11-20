#!/usr/bin/env python3
"""Build the qq-bridge release zip with UTF-8-safe filenames.

Windows ``tar.exe`` writes non-ASCII member names using the system codepage
(GBK on zh-CN) without setting the ZIP UTF-8 flag.  Such archives lose names
like ``assets/deepseek娘.png`` or ``roles/小鲸鱼-微调.md`` when unpacked.
This script therefore uses Python's ``zipfile`` only, explicitly sets bit 11
(``0x800``) for every non-ASCII path, and verifies the archive by unpacking it
again and comparing every file's SHA-256 with the source.

Usage:
    python scripts/release-pack.py --src "D:\\release" \\
        --out "D:\\out\\qq-bridge-1.1.0.zip" [--check]

Only the Python standard library is used.  The source tree is read-only.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
import shutil
import stat
import sys
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

UTF8_FLAG = 0x800
CHUNK_SIZE = 1024 * 1024

FORBIDDEN_DIR_PARTS = frozenset({"state", "node_modules", ".git"})

# Fish Diary 是用户的私人日记（见 docs/superpowers/plans/2026-10-25-fish-diary-design-taskcard.md §11）。
# 它被 .gitignore 忽略，但本脚本用 os.walk 而不是 git ls-files，所以必须单独处理：
#   ① 收集阶段直接剪掉该目录（不下降进去，连里面的文件都不列举）；
#   ② _forbidden_reason 再兜一次底 —— 万一将来有人改坏剪枝逻辑，
#      校验阶段会让打包**中止**，而不是把一个含日记内容的 zip 悄悄做出来。
EXCLUDED_DIR_PARTS = frozenset({"fish diary"})
FORBIDDEN_FILE_NAMES = frozenset({"config.json", "thumbs.db"})
FORBIDDEN_FILE_GLOBS = ("*.zip", "*.bak-*", "*.tmp")
FORBIDDEN_FILE_PREFIXES = ("~$",)

REQUIRED_FILES = (
    "package.json",
    "src/bridge.js",
    "scripts/setup-dsh.mjs",
    "dsh/agent-presets/qq-chat-v2/agent.cordis.yml",
    "plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml",
    "README.md",
    "CHANGELOG.md",
)


class PackError(RuntimeError):
    """A validation or packaging failure with a user-facing message."""


@dataclass(frozen=True)
class SourceFile:
    rel: str          # forward-slash relative path, exactly as stored in the zip
    path: Path        # absolute source path
    size: int
    mtime: float


def _configure_stdio() -> None:
    """Make Chinese paths printable on a cp936 Windows console / piped output."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass


def _is_link_like(path: Path) -> bool:
    """Return True for symlinks and Windows junctions (do not follow them)."""
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        if is_junction is not None and is_junction():
            return True
    except OSError:
        return False
    return False


def _rel_posix(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def scan_source(src: Path) -> tuple[list[SourceFile], list[str]]:
    """Recursively collect every regular file, hidden files included."""
    files: list[SourceFile] = []
    dirs: list[str] = []

    def on_walk_error(exc: OSError) -> None:
        raise PackError(f"遍历源目录失败: {exc}")

    for root, dirnames, filenames in os.walk(
        src, topdown=True, onerror=on_walk_error, followlinks=False
    ):
        root_path = Path(root)
        dirnames.sort(key=str.casefold)
        filenames.sort(key=str.casefold)

        # 剪枝：Fish Diary 目录整个不打包，也不下降进去（避免把里面的文件名/大小带进 zip）。
        kept: list[str] = []
        for name in dirnames:
            if name.casefold() in EXCLUDED_DIR_PARTS:
                continue
            kept.append(name)
        dirnames[:] = kept

        for name in dirnames:
            path = root_path / name
            rel = _rel_posix(path, src)
            if _is_link_like(path):
                raise PackError(f"源目录包含符号链接/联接目录，拒绝打包: {rel}/")
            dirs.append(rel)

        for name in filenames:
            path = root_path / name
            rel = _rel_posix(path, src)
            if _is_link_like(path):
                raise PackError(f"源目录包含符号链接/联接文件，拒绝打包: {rel}")
            try:
                st = path.stat()
            except OSError as exc:
                raise PackError(f"无法读取源文件信息: {rel}: {exc}") from exc
            if not stat.S_ISREG(st.st_mode):
                raise PackError(f"源目录包含非普通文件，拒绝打包: {rel}")
            files.append(SourceFile(rel, path, st.st_size, st.st_mtime))

    files.sort(key=lambda item: item.rel.casefold())
    dirs.sort(key=str.casefold)
    return files, dirs


def _forbidden_reason(rel: str, is_dir: bool) -> str | None:
    parts = [part.casefold() for part in PurePosixPath(rel).parts]
    if not parts:
        return None

    for part in parts:
        if part in FORBIDDEN_DIR_PARTS:
            return f"禁止目录/路径组件 {part!r}"

    # 私人日记：正常路径下 scan_source 已经剪枝，走到这里说明剪枝被破坏 —— 必须中止打包，
    # 而不是安静地把它打进 zip（fail-closed）。
    for part in parts:
        if part in EXCLUDED_DIR_PARTS:
            return f"禁止目录/路径组件 {part!r}（私人日记，不得打包）"

    if is_dir:
        return None

    base = parts[-1]
    if base in FORBIDDEN_FILE_NAMES:
        return f"禁止文件 {base!r}"
    for pattern in FORBIDDEN_FILE_GLOBS:
        if fnmatch.fnmatchcase(base, pattern):
            return f"禁止通配模式 {pattern!r}"
    for prefix in FORBIDDEN_FILE_PREFIXES:
        if base.startswith(prefix):
            return f"禁止前缀 {prefix!r}"
    return None


def check_forbidden(dirs: list[str], files: list[SourceFile]) -> list[str]:
    """Return every forbidden directory/file, not just the first one."""
    problems: list[str] = []
    for rel in dirs:
        reason = _forbidden_reason(rel, is_dir=True)
        if reason:
            problems.append(f"{rel}/  ({reason})")
    for item in files:
        reason = _forbidden_reason(item.rel, is_dir=False)
        if reason:
            problems.append(f"{item.rel}  ({reason})")
    return problems


def check_required(files: list[SourceFile]) -> tuple[list[str], list[str]]:
    """Return (missing required paths, role markdown files)."""
    by_path = {item.rel.casefold(): item.rel for item in files}
    missing = [name for name in REQUIRED_FILES if name.casefold() not in by_path]

    role_mds = [
        item.rel
        for item in files
        if len(PurePosixPath(item.rel).parts) >= 2
        and PurePosixPath(item.rel).parts[0].casefold() == "roles"
        and PurePosixPath(item.rel).parts[-1].casefold().endswith(".md")
    ]
    if not role_mds:
        missing.append("roles/*.md (至少 1 个)")
    return missing, role_mds


def non_ascii_files(files: list[SourceFile]) -> list[SourceFile]:
    return [item for item in files if not item.rel.isascii()]


def _print_non_ascii(non_ascii: list[SourceFile], checked: bool) -> None:
    state = "已确认 zip 同名条目 + UTF-8 标志" if checked else "待写入 zip"
    print(f"[utf8] 非 ASCII 文件名: {len(non_ascii)} 个 ({state})")
    for index, item in enumerate(non_ascii[:10], 1):
        print(f"  {index:>2}. {item.rel}")
    if len(non_ascii) > 10:
        print(f"  ... 其余 {len(non_ascii) - 10} 个")


def _zip_date_time(mtime: float) -> tuple[int, int, int, int, int, int]:
    try:
        value = time.localtime(mtime)
    except (OverflowError, OSError, ValueError):
        return (1980, 1, 1, 0, 0, 0)
    year = value.tm_year
    if year < 1980 or year > 2107:
        return (1980, 1, 1, 0, 0, 0)
    return (year, value.tm_mon, value.tm_mday, value.tm_hour, value.tm_min, value.tm_sec)


def write_zip(zip_path: Path, files: list[SourceFile]) -> None:
    """Write one entry per source file, explicitly forcing UTF-8 for non-ASCII."""
    with zipfile.ZipFile(
        zip_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True
    ) as archive:
        for item in files:
            st = item.path.stat()
            info = zipfile.ZipInfo(item.rel, date_time=_zip_date_time(st.st_mtime))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # Unix, so external_attr carries a file mode
            info.external_attr = (stat.S_IFREG | stat.S_IMODE(st.st_mode)) << 16
            if not item.rel.isascii():
                info.flag_bits |= UTF8_FLAG
                # Explicit assertion that cannot be stripped by ``python -O``.
                if not (info.flag_bits & UTF8_FLAG):
                    raise PackError(f"无法为中文名设置 UTF-8 标志: {item.rel}")

            with item.path.open("rb") as source_handle:
                with archive.open(
                    info, "w", force_zip64=item.size > 0x7FFFFFFF
                ) as target_handle:
                    shutil.copyfileobj(source_handle, target_handle, CHUNK_SIZE)


def inspect_zip(
    zip_path: Path, files: list[SourceFile], non_ascii: list[SourceFile]
) -> tuple[list[zipfile.ZipInfo], int]:
    """Re-open the zip and verify names, UTF-8 flags, entry count and CRC."""
    with zipfile.ZipFile(zip_path, "r") as archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        names = [info.filename for info in infos]
        name_set = set(names)

        if len(names) != len(name_set):
            raise PackError("zip 中存在重复条目名")
        seen: dict[str, str] = {}
        for name in names:
            folded = name.casefold()
            if folded in seen:
                raise PackError(f"zip 条目名大小写冲突: {seen[folded]} / {name}")
            seen[folded] = name

        expected = {item.rel for item in files}
        missing = sorted(expected - name_set)
        extra = sorted(name_set - expected)
        if missing:
            raise PackError(f"zip 缺少 {len(missing)} 个源文件，例如: {missing[:5]}")
        if extra:
            raise PackError(f"zip 多出 {len(extra)} 个条目，例如: {extra[:5]}")

        for info in infos:
            pure = PurePosixPath(info.filename)
            if pure.is_absolute() or ".." in pure.parts:
                raise PackError(f"zip 条目路径非法: {info.filename!r}")
            if pure.parts and ":" in pure.parts[0]:
                raise PackError(f"zip 条目含盘符: {info.filename!r}")

        by_name = {info.filename: info for info in infos}
        for item in non_ascii:
            info = by_name.get(item.rel)
            if info is None:
                raise PackError(f"zip 中缺少非 ASCII 文件名条目: {item.rel}")
            if info.filename != item.rel:
                raise PackError(
                    f"zip 中文名解码不一致: 期望 {item.rel!r}，实际 {info.filename!r}"
                )
            if not (info.flag_bits & UTF8_FLAG):
                raise PackError(f"zip 中文名条目缺少 UTF-8 标志: {item.rel}")

        bad = archive.testzip()
        if bad is not None:
            raise PackError(f"zip CRC 校验失败: {bad}")

    return infos, len(non_ascii)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def verify_readback(
    zip_path: Path, files: list[SourceFile], non_ascii: list[SourceFile]
) -> tuple[int, int]:
    """Unpack to a temp directory; compare counts and every file's SHA-256."""
    temp_root = Path(tempfile.mkdtemp(prefix="qq-bridge-readback-"))
    try:
        with zipfile.ZipFile(zip_path, "r") as archive:
            archive.extractall(temp_root)

        extracted = [path for path in temp_root.rglob("*") if path.is_file()]
        actual = {path.relative_to(temp_root).as_posix() for path in extracted}
        expected = {item.rel for item in files}

        if len(extracted) != len(files):
            raise PackError(
                f"回读文件数不一致: 解压 {len(extracted)}，源 {len(files)}"
            )
        if actual != expected:
            missing = sorted(expected - actual)
            extra = sorted(actual - expected)
            raise PackError(f"回读路径集合不一致: 缺少 {missing[:5]}，多出 {extra[:5]}")

        mismatches: list[str] = []
        for item in files:
            source_hash = sha256_file(item.path)
            unpacked_path = temp_root / Path(*PurePosixPath(item.rel).parts)
            if not unpacked_path.is_file():
                mismatches.append(item.rel)
                continue
            if sha256_file(unpacked_path) != source_hash:
                mismatches.append(item.rel)
        if mismatches:
            raise PackError(
                f"回读内容 hash 不一致 {len(mismatches)} 个，例如: {mismatches[:5]}"
            )

        for item in non_ascii:
            unpacked_path = temp_root / Path(*PurePosixPath(item.rel).parts)
            if not unpacked_path.is_file():
                raise PackError(f"回读后中文名不存在: {item.rel}")

        return len(extracted), len(non_ascii)
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="使用 Python zipfile 打包 qq-bridge 发布包（中文名安全）"
    )
    parser.add_argument("--src", required=True, help="发布源目录（只读）")
    parser.add_argument("--out", required=True, help="输出 zip 路径")
    parser.add_argument(
        "--check", action="store_true", help="只做校验并报告，不写 zip"
    )
    return parser


def run(argv: list[str] | None = None) -> int:
    _configure_stdio()
    args = build_parser().parse_args(argv)

    src = Path(args.src).expanduser()
    if not src.exists():
        raise PackError(f"--src 不存在: {src}")
    if not src.is_dir():
        raise PackError(f"--src 不是目录: {src}")
    src = src.resolve()

    files, dirs = scan_source(src)
    total_bytes = sum(item.size for item in files)
    hidden = sum(
        1
        for item in files
        if any(part.startswith(".") for part in PurePosixPath(item.rel).parts)
    )
    non_ascii = non_ascii_files(files)

    print(f"[src] {src}")
    print(
        f"[src] 文件数: {len(files)} | 目录数: {len(dirs)} | "
        f"{total_bytes} 字节 ({total_bytes / 1048576:.2f} MiB) | 隐藏文件: {hidden}"
    )

    problems = check_forbidden(dirs, files)
    if problems:
        print(f"[check] 禁止项: 命中 {len(problems)} 处", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        raise PackError(f"禁止项校验失败（{len(problems)} 处），已中止")
    print(
        "[check] 禁止项: 通过 "
        "(state/ config.json node_modules/ .git/ Fish_Diary/ *.zip *.bak-* ~$* *.tmp Thumbs.db)"
    )

    missing, role_mds = check_required(files)
    if missing:
        print(f"[check] 必需项: 缺失 {len(missing)} 项", file=sys.stderr)
        for name in missing:
            print(f"  - {name}", file=sys.stderr)
        raise PackError(f"必需项校验失败（{len(missing)} 项），已中止")
    print(f"[check] 必需项: 通过 (roles/*.md: {len(role_mds)} 个)")

    _print_non_ascii(non_ascii, checked=False)

    if args.check:
        print(f"[check] 仅校验模式：未写 zip；预计条目数: {len(files)}")
        return 0

    out = Path(args.out).expanduser()
    if not out.is_absolute():
        out = Path.cwd() / out
    out = out.resolve()
    if _is_within(out, src):
        raise PackError(f"--out 不能位于 --src 内（避免污染发布源）: {out}")
    if out.exists() and out.is_dir():
        raise PackError(f"--out 是目录，不是文件: {out}")

    out.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{out.name}.", suffix=".tmp", dir=str(out.parent)
    )
    os.close(fd)
    temp_path = Path(temp_name)

    try:
        write_zip(temp_path, files)
        temp_path.chmod(0o644)
        infos, verified_utf8 = inspect_zip(temp_path, files, non_ascii)

        print(f"[zip] 条目数: {len(infos)}（源文件数 {len(files)}）")
        print(f"[zip] 中文名/UTF-8 标志: {verified_utf8}/{len(non_ascii)} 条通过")
        print("[zip] CRC testzip: 通过")
        _print_non_ascii(non_ascii, checked=True)

        unpacked, verified_chinese = verify_readback(temp_path, files, non_ascii)
        print(f"[readback] 解压后文件数: {unpacked}（源 {len(files)}）")
        print(f"[readback] 逐条内容 sha256: {len(files)}/{len(files)} 一致")
        print(f"[readback] 中文名落盘: {verified_chinese}/{len(non_ascii)} 存在")

        temp_size = temp_path.stat().st_size
        os.replace(temp_path, out)
    finally:
        try:
            temp_path.unlink()
        except OSError:
            pass

    size = out.stat().st_size
    digest = sha256_file(out)
    print(f"[done] zip: {out}")
    print(f"[done] 条目数: {len(files)}")
    print(f"[done] zip 字节数: {size} 字节 ({size / 1048576:.2f} MiB)")
    print(f"[done] 解压后文件数: {unpacked}")
    print(f"[done] sha256: {digest}")
    print(
        f"[done] 回读校验: 通过（文件数 {unpacked}，内容 hash {len(files)}/{len(files)}，"
        f"中文名 {verified_chinese}/{len(non_ascii)}，zip 大小 {temp_size} 字节）"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        return run(argv)
    except PackError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"[FAIL] 文件操作失败: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
