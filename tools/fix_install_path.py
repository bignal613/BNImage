# -*- coding: utf-8 -*-
"""把安装/卸载脚本里写死的 D:\BNImage 改成自适应：有 D 盘装 D 盘，
没有则装到 %LOCALAPPDATA%\Programs\BNImage（免管理员权限）。"""
import re

BLOCK_INSTALL = (
    'rem ---- 0. \u9009\u62e9\u5b89\u88c5\u4f4d\u7f6e\uff1a\u6709 D \u76d8\u88c5 D \u76d8\uff0c'
    '\u5426\u5219\u88c5\u5230\u7528\u6237\u76ee\u5f55\uff08\u514d\u7ba1\u7406\u5458\uff09----\r\n'
    'set "DEST=D:\\BNImage"\r\n'
    'if not exist "D:\\" set "DEST=%LOCALAPPDATA%\\Programs\\BNImage"\r\n'
)

BLOCK_UNINST = (
    'set "DEST=D:\\BNImage"\r\n'
    'if not exist "D:\\" set "DEST=%LOCALAPPDATA%\\Programs\\BNImage"\r\n'
)

# 兼容各种已被写坏的形式：D://BNImage 、字面 \n 、字面 /n
PAT_INSTALL = re.compile(
    r'rem ---- 0\..*?Programs\\BNImage"\r?\n',
    re.S,
)
PAT_UNINST = re.compile(
    r'set "DEST=D:[/\\]{1,2}BNImage"(\r?\n)?(?:/n|\\n)?if not exist "D:[/\\]+" '
    r'set "DEST=%LOCALAPPDATA%\\Programs\\BNImage"\r?\n',
)


def fix(fname, pattern, block, expect_old=None):
    raw = open(fname, 'rb').read()
    text = raw.decode('gbk')
    m = pattern.search(text)
    if m:
        text = text[:m.start()] + block + text[m.end():]
        written = 'replaced'
    elif expect_old and expect_old in text:
        text = text.replace(expect_old, block, 1)
        written = 'replaced-old'
    else:
        written = 'no-match'
    open(fname, 'wb').write(text.encode('gbk'))
    return written


print(fix('\u5b89\u88c5.bat', PAT_INSTALL, BLOCK_INSTALL, 'set "DEST=D://BNImage"'))
print(fix('\u5378\u8f7d.bat', PAT_UNINST, BLOCK_UNINST, 'set "DEST=D://BNImage"'))

for f in ('\u5b89\u88c5.bat', '\u5378\u8f7d.bat'):
    t = open(f, 'rb').read().decode('gbk')
    print('==', f)
    for i, line in enumerate(t.splitlines(), 1):
        s = line.strip()
        if 'DEST' in s and ('set' in s or 'BNImage"' in s):
            if i < 40:
                print(' ', i, repr(s))
