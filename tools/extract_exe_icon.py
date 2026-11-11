# -*- coding: utf-8 -*-
"""从 exe 的资源段提取 RT_GROUP_ICON，重建 .ico，用于核对内嵌图标。"""
import struct, sys
import pefile

EXE = sys.argv[1] if len(sys.argv) > 1 else 'BNImage.exe'
OUT = sys.argv[2] if len(sys.argv) > 2 else '_icon_test/_exe_embed.ico'

pe = pefile.PE(EXE, fast_load=True)
pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])

RT_ICON, RT_GROUP_ICON = 3, 14


def find(rtype):
    out = {}
    for e in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if e.id != rtype:
            continue
        for d in e.directory.entries:
            for lang in d.directory.entries:
                out[d.id] = pe.get_data(lang.data.struct.OffsetToData, lang.data.struct.Size)
    return out


groups = find(RT_GROUP_ICON)
icons = find(RT_ICON)
print('%s: group_icon=%d  icon=%d' % (EXE, len(groups), len(icons)))

gid = sorted(groups)[0]
g = groups[gid]
reserved, typ, count = struct.unpack_from('<HHH', g, 0)
print('group id=%d type=%d entries=%d' % (gid, typ, count))

ents = []
for i in range(count):
    w, h, cc, rsv, planes, bpp, size, nid = struct.unpack_from('<BBBBHHIH', g, 6 + i * 14)
    ents.append((w or 256, h or 256, cc, planes, bpp, size, nid))

hdr = struct.pack('<HHH', 0, 1, count)
offset = 6 + 16 * count
blobs, dirs = [], b''
for w, h, cc, planes, bpp, size, nid in ents:
    data = icons[nid]
    dirs += struct.pack('<BBBBHHII', w if w < 256 else 0, h if h < 256 else 0,
                        cc, 0, planes, bpp, len(data), offset)
    offset += len(data)
    blobs.append(data)
    print('  %3dx%-3d bpp=%d  %d bytes' % (w, h, bpp, len(data)))

open(OUT, 'wb').write(hdr + dirs + b''.join(blobs))
print('wrote', OUT)
