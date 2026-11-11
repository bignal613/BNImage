"""把 BNImage 支持、但目前被别的程序占着的格式，改由 BNImage 接管（图标才会跟着格式走）。

Windows 只按「默认打开方式」决定文件图标，所以要让 webp 显示 WEBP 徽标，
只能让 BNImage 成为它的默认程序。默认只打印，不改动任何东西。

用法:
  python tools/claim_type_icons.py                # 只看会改哪些
  python tools/claim_type_icons.py --yes          # 真的改
  python tools/claim_type_icons.py --yes --only webp,heic,mkv
"""
import argparse
import json
import sys
import winreg
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TYPES = ROOT / "icons" / "types.json"


def read(path, name=""):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="实际写入")
    ap.add_argument("--only", default="", help="逗号分隔的扩展名，默认全部")
    args = ap.parse_args()

    if not TYPES.exists():
        sys.exit("找不到 icons/types.json，请先跑 tools/make_type_icons.py")
    table = json.loads(TYPES.read_text(encoding="utf-8"))["types"]

    only = {e.strip().lstrip(".").lower() for e in args.only.split(",") if e.strip()}
    plan = []
    for t in table:
        for e in t["exts"]:
            if only and e not in only:
                continue
            prog = f"BNImage.{t['group']}.{t['label']}"
            uc = read(rf"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{e}\UserChoice",
                      "ProgId")
            cur = read(rf"Software\Classes\.{e}", "")
            if str(cur) == prog and not uc:
                continue
            plan.append((e, prog, uc or cur or "（无）"))

    if not plan:
        print("已经全部由 BNImage 接管，无需改动。")
        return

    print(f"{'扩展名':8} {'将指向':28} 当前")
    for e, prog, cur in plan:
        print(f".{e:7} {prog:28} {cur}")

    if not args.yes:
        print(f"\n共 {len(plan)} 项待改。确认无误后加 --yes 执行；"
              "改动可在「设置 → 默认应用」里逐个改回。")
        return

    done = 0
    for e, prog, _cur in plan:
        # 1) 去掉旧的选择（写 UserChoice 需要哈希，删掉即可让下面的默认值生效）
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER,
                             rf"Software\Microsoft\Windows\CurrentVersion\Explorer"
                             rf"\FileExts\.{e}\UserChoice")
        except OSError:
            pass
        # 2) 扩展名默认值指向本格式的 ProgID
        try:
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER,
                                    rf"Software\Classes\.{e}", 0, winreg.KEY_WRITE) as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, prog)
            done += 1
        except OSError as exc:
            print(f"  .{e} 写入失败: {exc}")
    import ctypes
    ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
    print(f"已改 {done} 项；资源管理器可能需要刷新或重启才能看到新图标。")


if __name__ == "__main__":
    main()
