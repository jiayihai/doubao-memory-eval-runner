"""Read-only ZIP/XML verification of the offline QA workbook; no Excel authoring."""
import json
import pathlib
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
qa = pathlib.Path(sys.argv[1]).resolve()
acceptance = json.loads((qa / '离线验收.json').read_text(encoding='utf8'))
manifest = json.loads(pathlib.Path(acceptance['result']['report']).read_text(encoding='utf8'))


def load(path):
    archive = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in archive.namelist():
        shared = [''.join(n.itertext()) for n in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
    sheets = []
    for name in ('xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'):
        xml = ET.fromstring(archive.read(name))
        cells = {}
        for cell in xml.findall('.//s:sheetData/s:row/s:c', NS):
            value, formula = cell.find('s:v', NS), cell.find('s:f', NS)
            if cell.get('t') == 's':
                text = shared[int(value.text)] if value is not None and value.text else ''
            elif cell.get('t') == 'inlineStr':
                text = ''.join(cell.find('s:is', NS).itertext())
            else:
                text = value.text if value is not None and value.text is not None else ''
            cells[cell.get('r')] = {'value': text, 'formula': formula.text if formula is not None else None,
                                   'style': cell.get('s', '0')}
        sheets.append((xml, cells))
    return archive, sheets


old_zip, old = load(manifest['template'])
new_zip, new = load(acceptance['result']['file'])
issues, adjusted_heights = [], []
filled_flow = {str(row['row']) for row in manifest['rows']}
filled_questions = {str(row['questionRow']) for row in manifest['rows'] if row['questionRow']}
for i, ((old_xml, old_cells), (new_xml, new_cells)) in enumerate(zip(old, new)):
    for address, before in old_cells.items():
        after = new_cells.get(address, {'value': '', 'formula': None, 'style': '0'})
        col = ''.join(ch for ch in address if ch.isalpha())
        row = int(''.join(ch for ch in address if ch.isdigit()))
        allowed = row > 1 and ((i == 0 and col in ('I', 'J', 'K')) or (i == 1 and col in ('L', 'M')))
        if before['formula'] != after['formula']:
            issues.append(['formula', i, address])
        if not allowed and before['value'] != after['value']:
            issues.append(['value', i, address])
        if before['style'] != after['style']:
            issues.append(['cell_style', i, address])
    for feature in ('cols', 'sheetViews', 'sheetFormatPr', 'dataValidations', 'conditionalFormatting', 'autoFilter'):
        before = [ET.tostring(x) for x in old_xml.findall('s:' + feature, NS)]
        after = [ET.tostring(x) for x in new_xml.findall('s:' + feature, NS)]
        if before != after:
            issues.append(['feature', i, feature])
    before_heights = {r.get('r'): r.get('ht') for r in old_xml.findall('s:sheetData/s:row', NS)}
    for row in new_xml.findall('s:sheetData/s:row', NS):
        rid, height = row.get('r'), row.get('ht')
        if before_heights.get(rid) == height:
            continue
        allowed = filled_flow if i == 0 else filled_questions
        if rid not in allowed or not (float(before_heights[rid]) <= float(height) <= 409.5):
            issues.append(['row_height', i, rid, height])
        adjusted_heights.append([i, rid, height])

styles_equal = ET.tostring(ET.fromstring(old_zip.read('xl/styles.xml'))) == ET.tostring(ET.fromstring(new_zip.read('xl/styles.xml')))
tables_equal = {}
for name in old_zip.namelist():
    if name.startswith('xl/tables/') and name.endswith('.xml'):
        tables_equal[name] = ET.tostring(ET.fromstring(old_zip.read(name))) == ET.tostring(ET.fromstring(new_zip.read(name)))
result = {'issues': issues, 'stylesUnchanged': styles_equal, 'tablesUnchanged': tables_equal,
          'formulaCount': sum(bool(cell['formula']) for cell in new[1][1].values()),
          'adjustedHeights': adjusted_heights, 'displayLimitedReplies': len(manifest.get('displayLimitedRows', []))}
(qa / '原生文件核验.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps({**result, 'adjustedHeights': len(adjusted_heights)}, ensure_ascii=True))
assert not issues and styles_equal and all(tables_equal.values())
