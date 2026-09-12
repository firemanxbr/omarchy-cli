#!/usr/bin/env python3
"""Generates SQL that seeds the index with N synthetic packages and an `edge`
release containing all of them. Used by tests/bench-promotion.sh.

Package shapes follow rough Arch averages: ~18 MB download (275 GB / ~15k
packages), 40 files, 8 requirements, 3 provides. Only the index is seeded —
promotion never touches package bytes, which is the point being measured.
"""

import hashlib
import json
import sys

N = int(sys.argv[1]) if len(sys.argv) > 1 else 10_000
AVG_DOWNLOAD = 18 * 1024 * 1024
ROWS_PER_STMT = 400


def q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def manifest(i: int) -> dict:
    name = f"bench-pkg-{i}"
    version = f"1.{i}-1"
    sha = hashlib.sha256(name.encode()).hexdigest()
    deps = [f"bench-pkg-{(i * 7 + k) % N}" for k in range(1, 4)] + ["glibc"]
    requires = deps + ["libc.so.6", "libc.so.6(GLIBC_2.34)", f"libbench{i % 50}.so.1", "sh"]
    provides = [f"{name}={version}", f"libbench{i}.so=1-64", f"libbench{i}.so.1"]
    files = ["/usr/", "/usr/bin/", f"/usr/bin/{name}", "/usr/lib/", f"/usr/lib/libbench{i}.so.1",
             f"/usr/share/{name}/"] + [f"/usr/share/{name}/file{k}.dat" for k in range(34)]
    return {
        "schema_version": 2,
        "name": name,
        "version": version,
        "arch": "x86_64",
        "description": f"Synthetic benchmark package {i}",
        "url": "https://example.invalid",
        "licenses": ["MIT"],
        "size_installed": AVG_DOWNLOAD * 3,
        "size_download": AVG_DOWNLOAD,
        "sha256": sha,
        "filename": f"{name}-{version}-x86_64.pkg.tar.zst",
        "pkginfo": {"base": name, "builddate": 1700000000 + i, "packager": "bench",
                    "depends": deps, "provides": [f"libbench{i}.so=1-64"]},
        "provides": provides,
        "requires": requires,
        "files": files,
    }


def emit_batches(table_cols: str, rows: list[str], per_stmt: int = ROWS_PER_STMT) -> None:
    # D1 caps a statement at 100 KB; manifests are ~2.4 KB each.
    for start in range(0, len(rows), per_stmt):
        chunk = rows[start:start + per_stmt]
        print(f"INSERT INTO {table_cols} VALUES\n" + ",\n".join(chunk) + ";")


def main() -> None:
    pkg_rows, prov_rows, req_rows, file_rows = [], [], [], []
    for i in range(N):
        m = manifest(i)
        pid = i + 1  # AUTOINCREMENT on an empty table
        pkg_rows.append(
            f"({pid}, {q(m['sha256'])}, {q(m['name'])}, {q(m['version'])}, 'x86_64', {q(m['filename'])}, "
            f"{m['size_download']}, {m['size_installed']}, 1, {q(json.dumps(m, separators=(',', ':')))})"
        )
        for p in m["provides"]:
            name, _, ver = p.partition("=")
            prov_rows.append(f"({pid}, {q(name)}, {q('=' + ver) if ver else 'NULL'}, NULL)")
        for r in m["requires"]:
            sym = None
            if "(" in r:
                r, sym = r[:r.index("(")], r[r.index("(") + 1:-1]
            req_rows.append(f"({pid}, {q(r)}, NULL, {q(sym) if sym else 'NULL'}, 'depends')")
        for f in m["files"]:
            file_rows.append(f"({pid}, {q(f)})")

    print("PRAGMA foreign_keys = OFF;")
    emit_batches("packages (id, sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json)", pkg_rows, per_stmt=30)
    emit_batches("package_provides (package_id, capability, version_constraint, symbol_version)", prov_rows)
    emit_batches("package_requires (package_id, requirement, version_constraint, symbol_version, kind)", req_rows)
    emit_batches("package_files (package_id, file_path)", file_rows)
    print("INSERT INTO releases (id, ring, seq, note) VALUES (1, 'edge', 1, 'bench seed');")
    print("INSERT INTO release_packages (release_id, package_id) SELECT 1, id FROM packages;")
    print("INSERT INTO ring_heads (ring, release_id) VALUES ('edge', 1);")


if __name__ == "__main__":
    main()
