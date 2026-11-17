/* Word (.docx) do briefing de criativo, montado direto com a biblioteca docx
   (sem LibreOffice). Desenha o mesmo modelo da prévia (BriefingSchema.docModel)
   no layout do Word do Agente de Criação: A4, margens de 2 cm, Arial 10 pt,
   faixas escuras numeradas, tabelas de duas colunas com o rótulo em cinza
   claro e número da página no rodapé. */
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType,
  BorderStyle, AlignmentType, VerticalAlign, PageOrientation, Footer, PageNumber, ImageRun
} = require('docx');
const BriefingSchema = require('./public/js/briefing-schema.js');

const FONTE = 'Arial';
const COR = { escuro: '262626', rotulo: 'F2F2F2', borda: 'BFBFBF', dica: '7F7F7F', nota: 'FFF4E5', tag: 'E8F0FE', tagTexto: '1A56B0' };
const LARG = 9638;
const COL = [3200, LARG - 3200];
const borda = { style: BorderStyle.SINGLE, size: 4, color: COR.borda };
const bordas = { top: borda, bottom: borda, left: borda, right: borda };
const sem = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const semBordas = { top: sem, bottom: sem, left: sem, right: sem };

const t = (texto, o = {}) => new TextRun({
  text: String(texto), font: FONTE, size: o.size || 20, bold: o.bold, color: o.color, italics: o.italics,
  shading: o.fundo ? { fill: o.fundo, type: ShadingType.CLEAR, color: 'auto' } : undefined
});
const p = (filhos, o = {}) => new Paragraph({
  children: Array.isArray(filhos) ? filhos : [filhos],
  spacing: { before: o.before ?? 0, after: o.after ?? 0 }, alignment: o.align, keepNext: o.keepNext
});
function celula(filhos, largura, o = {}) {
  return new TableCell({
    children: filhos, width: { size: largura, type: WidthType.DXA }, borders: o.bordas || bordas,
    shading: o.fundo ? { fill: o.fundo, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 90, bottom: 90, left: 140, right: 140 }, verticalAlign: o.va || VerticalAlign.TOP
  });
}
const faixa = texto => new Table({
  width: { size: LARG, type: WidthType.DXA }, columnWidths: [LARG],
  rows: [new TableRow({ children: [celula([p(t(texto, { bold: true, color: 'FFFFFF', size: 22 }), { keepNext: true })], LARG,
    { fundo: COR.escuro, bordas: semBordas, va: VerticalAlign.CENTER })] })]
});
const nota = texto => new Table({
  width: { size: LARG, type: WidthType.DXA }, columnWidths: [LARG],
  rows: [new TableRow({ children: [celula([p(t(texto, { size: 18 }))], LARG, { fundo: COR.nota, bordas: semBordas })] })]
});
const sub = texto => p(t(texto, { bold: true, color: COR.dica }), { before: 160, after: 60, keepNext: true });
const espaco = (n = 240) => p(t(''), { after: n });

// Miniatura de imagem enviada ao reWork (/uploads/…): JPEG de até 320 px.
async function miniatura(url, uploadsDir) {
  try {
    if (!/^\/uploads\//.test(url)) return null;
    const file = path.join(uploadsDir, path.basename(url.split('?')[0]));
    if (!fs.existsSync(file)) return null;
    const sharp = require('sharp');
    const { data, info } = await sharp(file).rotate().resize({ width: 320, height: 240, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const w = Math.min(160, info.width);
    return new ImageRun({ type: 'jpg', data, transformation: { width: w, height: Math.round(info.height * w / info.width) } });
  } catch { return null; }
}

async function valor(v, uploadsDir) {
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    const after = i < v.length - 1 ? 60 : 0;
    if (typeof x === 'string') out.push(p(t(x), { after }));
    else if (x.img) { const img = await miniatura(x.img, uploadsDir); out.push(img ? p(img, { after }) : p(t(x.img, { color: COR.dica }), { after })); }
    else if (x.tag) out.push(p(t(` ${x.t} `, { size: 16, bold: true, color: COR.tagTexto, fundo: COR.tag }), { after }));
    else out.push(p(t(x.t, { color: COR.dica, italics: true }), { after }));
  }
  return out.length ? out : [p(t(''))];
}

/* ctx: o mesmo da prévia ({ client, blocks, orgName, status }) + uploadsDir. */
async function briefingToDocx(data, ctx) {
  const { blocks, set } = BriefingSchema.docModel(data, ctx);
  const corpo = [];
  for (const bl of blocks) {
    if (bl.type === 'title') {
      corpo.push(p(t(bl.title, { size: 40, bold: true, color: COR.escuro }), { after: 40 }));
      if (bl.line) corpo.push(p(t(bl.line, { size: 22 }), { after: 40 }));
      corpo.push(p(t(bl.small, { size: 18, color: COR.dica }), { after: 200 }));
    } else if (bl.type === 'band') {
      if (corpo.length && corpo[corpo.length - 1] instanceof Table) corpo.push(espaco());
      corpo.push(faixa(bl.text));
    } else if (bl.type === 'note') {
      corpo.push(nota(bl.text)); corpo.push(espaco(120));
    } else if (bl.type === 'sub') {
      corpo.push(sub(bl.text));
    } else if (bl.type === 'rows') {
      const rows = [];
      for (const [rot, v] of bl.rows) {
        rows.push(new TableRow({ cantSplit: true, children: [
          celula([p(t(rot, { bold: true }))], COL[0], { fundo: COR.rotulo }),
          celula(await valor(v, ctx.uploadsDir), COL[1])
        ] }));
      }
      corpo.push(new Table({ width: { size: LARG, type: WidthType.DXA }, columnWidths: COL, rows }));
    }
  }
  const doc = new Document({
    creator: ctx.orgName || 'reWork', title: `Briefing de criativo — ${set}`,
    styles: { default: { document: { run: { font: FONTE, size: 20 } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [p([t(`${set} · página `, { size: 16, color: COR.dica }), new TextRun({ children: [PageNumber.CURRENT], font: FONTE, size: 16, color: COR.dica })], { align: AlignmentType.RIGHT })] }) },
      children: corpo
    }]
  });
  return Packer.toBuffer(doc);
}

module.exports = { briefingToDocx };
