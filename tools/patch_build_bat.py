# -*- coding: utf-8 -*-
"""让 打包.bat 在缺少 ffmpeg.exe 时也能打包（开源仓库默认不带它）。"""
F = '\u6253\u5305.bat'          # 打包.bat
t = open(F, 'rb').read().decode('gbk')

old1 = '  --add-data "web;web" --add-data "bnimage.ico;." --add-binary "ffmpeg.exe;." ^'
new1 = '  --add-data "web;web" --add-data "bnimage.ico;." %FFARG% ^'

old2 = 'echo   [1/3] \u6253\u5305\u4e2d\uff08\u7ea6 30-60 \u79d2\uff09...'
new2 = (
    'rem ffmpeg \u4e0d\u662f\u5fc5\u9700\uff1a\u6ca1\u6709\u5b83\u4e5f\u80fd\u6253\u5305\uff0c'
    '\u53ea\u662f\u89c6\u9891\u8f6c\u7801\u4f1a\u964d\u7ea7\r\n'
    'set "FFARG="\r\n'
    'if exist "ffmpeg.exe" (set "FFARG=--add-binary ffmpeg.exe;.") else '
    '(echo   [!] \u672a\u627e\u5230 ffmpeg.exe\uff0c\u6253\u5305\u540e\u89c6\u9891\u8f6c\u7801\u4e0d\u53ef\u7528)\r\n'
    + old2
)

assert old1 in t, 'add-binary 行没匹配上'
assert old2 in t, '打包提示行没匹配上'
t = t.replace(old1, new1, 1).replace(old2, new2, 1)
open(F, 'wb').write(t.encode('gbk'))
print('done, len =', len(t))
