#!/usr/bin/env python3
"""
情感记忆清洗表 — 从 feelings 文件生成清洗表格

用法:
  python3 cleanup-feelings.py <feelings_file> [output_file]
"""

import json, re, sys, os

def main():
    if len(sys.argv) < 2:
        print("用法: python3 cleanup-feelings.py <feelings文件> [输出文件]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(input_file)[0] + "-cleanup.md"

    if not os.path.exists(input_file):
        print(f"文件不存在: {input_file}")
        sys.exit(1)

    with open(input_file, 'r') as f:
        raw = f.read()

    lines_data = []
    decoder = json.JSONDecoder()
    pos = 0
    raw_len = len(raw)

    while pos < raw_len:
        while pos < raw_len and raw[pos] in ' \t\n\r':
            pos += 1
        if pos >= raw_len:
            break
        try:
            obj, end = decoder.raw_decode(raw, pos)
            pos = end
            if obj.get('type') == 'feeling':
                content = obj.get('content', '').strip()
                lines_data.append(content)
        except json.JSONDecodeError:
            pos += 1

    out = ['# 情感记忆清洗表\n']
    out.append(f'共 {len(lines_data)} 条记录\n')
    out.append('| 序号 | 摘要文本 | 是否保留全文 |')
    out.append('|------|----------|-------------|')
    for idx, content in enumerate(lines_data, 1):
        cell = content.replace('|', '\\|')
        cell = re.sub(r'\s+', ' ', cell)
        out.append(f'| {idx} | {cell} |  |')

    with open(output_file, 'w') as f:
        f.write('\n'.join(out))

    print(f'Done. {len(lines_data)} rows → {output_file}')

if __name__ == '__main__':
    main()
