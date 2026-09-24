/* ═════════════════════════════════════════════════════════════════
   Kastor Docs — entrypoint do bundle do editor
   ─────────────────────────────────────────────
   Este arquivo NÃO é servido diretamente. Ele é bundled via esbuild
   em `public/vendor/writer.bundle.js` (ver scripts/build-writer.js).
   Exponho tudo o que o app.js precisa no window.KastorWriter — assim
   evito misturar módulos ES6 com o app.js monolítico legado.
   ═════════════════════════════════════════════════════════════════ */
import { Editor, Extension, Node, Mark, mergeAttributes, generateJSON } from '@tiptap/core';
import { Plugin, PluginKey, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { DOMSerializer, Fragment } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import { TextStyle, FontFamily, Color, FontSize } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
// ── Novas features (task list, code highlight, mention) ──
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';
import Mention from '@tiptap/extension-mention';
import Suggestion from '@tiptap/suggestion';
// ── Colaboração realtime ──
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';

// Lowlight singleton com os langs "common" (js, ts, py, bash, css, html,
// json, md, sql, xml, yaml, etc). Suficiente pra 95% dos casos e ~40KB.
const lowlight = createLowlight(common);

/* Cria um editor Tiptap no elemento `mount`, com os defaults do Kastor.
   `opts.content`   = ProseMirror JSON inicial (ou null)
   `opts.editable`  = true por padrão
   `opts.onUpdate`  = callback(editor, json) chamado a cada change (debounce feito fora)
   `opts.onSelectionUpdate` = callback(editor) — usado pra sincronizar toolbar
   `opts.placeholder` = texto do placeholder no primeiro parágrafo vazio */
/* Placeholder por bloco: título vazio mostra "Título N"; linha vazia com o
   cursor mostra a dica do "/"; documento vazio mostra o texto de boas-vindas. */
function _kdPlaceholder(base) {
  return ({ editor, node }) => {
    if (node.type.name === 'heading') return 'Título ' + (node.attrs.level || 1);
    if (editor.isEmpty) return base || 'Comece a escrever…';
    return 'Digite / para comandos';
  };
}

/* Extensões do editor — a MESMA lista pro editor local, o colaborativo e o
   schema do seed do Yjs (se divergir, o y-prosemirror descarta nós). */
function kdExtensions(opts = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      // Link/Underline configurados abaixo; codeBlock vira CodeBlockLowlight.
      link: false,
      underline: false,
      codeBlock: false,
      // Com colaboração o undo/redo é o do Yjs (os dois juntos conflitam).
      ...(opts.collab ? { undoRedo: false } : {})
    }),
    Underline,
    Link.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }
    }),
    Placeholder.configure({
      placeholder: _kdPlaceholder(opts.placeholder),
      emptyEditorClass: 'is-editor-empty',
      emptyNodeClass: 'is-empty'
    }),
    Table.configure({ resizable: true, HTMLAttributes: { class: 'writer-table' } }),
    KdTableRow, TableHeader, TableCell,
    KdImage.configure({ HTMLAttributes: { class: 'writer-image' } }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    KastorAttachment,
    KastorComment,
    PasteAsLink,
    TextStyle,
    FontFamily,
    FontSize,
    Color,
    Highlight.configure({ multicolor: true }),
    KdBlockIndent,
    KdLineHeight,
    KdSubscript,
    KdSuperscript,
    KdPages,
    KdPageBreak,
    KdSearch,
    TaskList.configure({ HTMLAttributes: { class: 'kd-task-list' } }),
    TaskItem.configure({ nested: true, HTMLAttributes: { class: 'kd-task-item' } }),
    CodeBlockLowlight.configure({ lowlight, HTMLAttributes: { class: 'kd-code-block' } }),
    KdCallout,
    KdColumn,
    KdColumnBlock,
    KdMention,
    KdReference,
    ...(opts.schemaOnly ? [] : [KdRefSuggest]),
    KdSlashCommand
  ];
}

function createKastorEditor(mount, opts = {}) {
  const editor = new Editor({
    element: mount,
    editable: opts.editable !== false,
    autofocus: opts.autofocus === true ? 'start' : (opts.autofocus || false),
    content: opts.content || null,
    extensions: kdExtensions({ placeholder: opts.placeholder }),
    onUpdate: ({ editor }) => {
      if (typeof opts.onUpdate === 'function') {
        try { opts.onUpdate(editor); } catch (e) { console.error('writer onUpdate:', e); }
      }
    },
    onSelectionUpdate: ({ editor }) => {
      if (typeof opts.onSelectionUpdate === 'function') {
        try { opts.onSelectionUpdate(editor); } catch (e) { console.error('writer onSelectionUpdate:', e); }
      }
    }
  });
  return editor;
}

/* Serializa o doc pra HTML — usado no export e nas prévias das cards. */
function editorToHTML(editor) {
  if (!editor) return '';
  return editor.getHTML();
}

/* Extrai texto puro (sem markup) — usado nas prévias e no export TXT. */
function editorToText(editor) {
  if (!editor) return '';
  return editor.getText();
}

/* Doc vazio no formato ProseMirror JSON — pra novos documentos. */
function emptyDoc() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/* ───────────────────────────────────────────────────────────────
   Colaboração realtime
   ─────────────────────────────
   Cria um editor conectado a um Y.Doc via WebsocketProvider.
   `opts.docId`        — id do doc (rota WS = /rt/docs/<id>)
   `opts.wsUrl`        — URL base do WS (ex.: "ws://host:3000/rt/docs")
   `opts.initialJSON`  — PM JSON pra bootstrap se o Y.Doc do servidor
                         estiver vazio (primeiro cliente conecta)
   `opts.user`         — { name, color } — mostrado no caret dos outros
   `opts.placeholder`  — texto do placeholder
   `opts.onStatus`     — callback('connecting'|'connected'|'disconnected')
   `opts.onUpdate`     — callback(editor, json) — pra autosave de PM JSON
   `opts.onSelectionUpdate` — pra atualizar toolbar

   Retorna { editor, provider, ydoc, destroy() }
   ─────────────────────────────────────────────────────────────── */
function createCollabEditor(mount, opts) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(opts.wsUrl, opts.docId, ydoc, {
    connect: true,
    // Não precisa passar params — auth é via cookie de sessão HTTP
  });

  if (typeof opts.onStatus === 'function') {
    provider.on('status', ({ status }) => {
      try { opts.onStatus(status); } catch {}
    });
  }

  // Awareness: identidade do usuário local
  // ATENÇÃO: campos como `id` e `avatar` são consumidos pela UI de presença
  // (renderPresence + miniperfil) do standalone.js. Se você mudar isto,
  // atualize também o consumidor.
  if (opts.user) {
    provider.awareness.setLocalStateField('user', {
      id:     opts.user.id     || null,
      name:   opts.user.name   || 'Usuário',
      color:  opts.user.color  || '#7A00FF',
      avatar: opts.user.avatar || null
    });
  }

  // Bootstrap: espera 1º sync. Se depois disso o Y.Doc estiver vazio
  // e temos initialJSON, seedamos aplicando um update construído do JSON.
  provider.once('synced', () => {
    if (!opts.initialJSON) return;
    // Fragmento vazio depois do sync = o doc nunca foi aberto em tempo real
    // (criado com conteúdo, cópia, import). O share 'default' sempre existe
    // aqui porque a extensão Collaboration o cria antes — não dá pra usar.
    const isEmpty = ydoc.getXmlFragment('default').length === 0;
    if (isEmpty) {
      try {
        // Semente determinística: mesmo clientID fixo → duas abas semeando ao
        // mesmo tempo geram itens idênticos e o Yjs descarta a cópia (em vez
        // de duplicar o documento).
        const seed = new Y.Doc();
        seed.clientID = 1;
        prosemirrorJSONToYXmlFragment(_schemaFromExtensions(), opts.initialJSON, seed.getXmlFragment('default'));
        const upd = Y.encodeStateAsUpdate(seed);
        Y.applyUpdate(ydoc, upd);
      } catch (e) {
        console.warn('[collab] falha ao seed inicial:', e);
      }
    }
  });

  const editor = new Editor({
    element: mount,
    editable: opts.editable !== false,
    // Aceita true (= 'start') ou string ('start' | 'end' | posição) direto.
    // 'start' é o default agora — abrir um doc joga cursor no topo em vez do
    // fim, evitando que o browser scrolle o paper até o fim do conteúdo.
    autofocus: opts.autofocus === true ? 'start' : (opts.autofocus || false),
    extensions: [
      ...kdExtensions({ placeholder: opts.placeholder, collab: true }),
      // Colab: substitui o history pelo Yjs undo/redo
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({
        provider,
        // CollaborationCaret também chama awareness.setLocalStateField('user',...)
        // com este objeto, SOBRESCREVENDO o que setamos antes. Por isso repetimos
        // id/avatar aqui — sem eles a presence não consegue mostrar foto nem
        // habilitar o miniperfil.
        user: {
          id:     opts.user?.id     || null,
          name:   opts.user?.name   || 'Usuário',
          color:  opts.user?.color  || '#7A00FF',
          avatar: opts.user?.avatar || null
        }
      })
    ],
    onUpdate: ({ editor }) => {
      if (typeof opts.onUpdate === 'function') {
        try { opts.onUpdate(editor); } catch {}
      }
    },
    onSelectionUpdate: ({ editor }) => {
      if (typeof opts.onSelectionUpdate === 'function') {
        try { opts.onSelectionUpdate(editor); } catch {}
      }
    }
  });

  return {
    editor, provider, ydoc,
    destroy() {
      try { editor.destroy(); } catch {}
      try { provider.destroy(); } catch {}
      try { ydoc.destroy(); } catch {}
    }
  };
}

/* ───────────────────────────────────────────────────────────────
   Node customizado: kastorAttachment
   ─────────────────────────────
   Um bloco atômico que representa 1 anexo da Galeria dentro do texto.
   Serializa como:
     <div data-kastor-att data-att-id data-name data-mime data-url data-size data-kind data-is-image>
   Renderiza inline como:
     - <img> se for imagem
     - card com ícone + nome + meta se for outro formato
   Ambos os casos: click → abre `data.viewerUrl` (que o standalone.js define
   antes de inserir), ou `data.url` (uploads) direto em nova aba como fallback.
   ─────────────────────────────────────────────────────────────── */
const KastorAttachment = Node.create({
  name: 'kastorAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: { default: null, parseHTML: e => e.getAttribute('data-att-id'), renderHTML: a => ({ 'data-att-id': a.attachmentId }) },
      name:         { default: '',   parseHTML: e => e.getAttribute('data-name'),   renderHTML: a => ({ 'data-name': a.name }) },
      mime:         { default: '',   parseHTML: e => e.getAttribute('data-mime'),   renderHTML: a => ({ 'data-mime': a.mime }) },
      url:          { default: '',   parseHTML: e => e.getAttribute('data-url'),    renderHTML: a => ({ 'data-url': a.url }) },
      size:         { default: 0,    parseHTML: e => Number(e.getAttribute('data-size') || 0), renderHTML: a => ({ 'data-size': String(a.size || 0) }) },
      kind:         { default: 'file', parseHTML: e => e.getAttribute('data-kind') || 'file', renderHTML: a => ({ 'data-kind': a.kind }) },
      isImage:      { default: false, parseHTML: e => e.getAttribute('data-is-image') === 'true', renderHTML: a => ({ 'data-is-image': String(!!a.isImage) }) }
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-kastor-att]' }];
  },

  // Pra y-prosemirror encodar o node corretamente ele precisa ver uma
  // representação DOM plana (leaf). Renderização rica fica no addNodeView.
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-kastor-att': 'true', class: 'kastor-att-node' })];
  },

  // NodeView pinta o conteúdo real com base nos attrs e adiciona os handlers
  // de click. É recriado quando o node é substituído — ideal pra Yjs.
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.setAttribute('data-kastor-att', 'true');
      dom.className = 'kastor-att-node';
      // Reflete todos os attrs pra parseHTML round-trippar via HTML
      const a = node.attrs || {};
      dom.setAttribute('data-att-id',  a.attachmentId || '');
      dom.setAttribute('data-name',    a.name || '');
      dom.setAttribute('data-mime',    a.mime || '');
      dom.setAttribute('data-url',     a.url || '');
      dom.setAttribute('data-size',    String(a.size || 0));
      dom.setAttribute('data-kind',    a.kind || 'file');
      dom.setAttribute('data-is-image', String(!!a.isImage));

      if (a.isImage && a.url) {
        dom.innerHTML =
          `<a class="kastor-att-img-link" href="${_escAttr(a.url)}" target="_blank" rel="noopener">
             <img class="kastor-att-img" src="${_escAttr(a.url)}" alt="${_escAttr(a.name)}" loading="lazy">
           </a>`;
      } else {
        const ext = (a.name || '').split('.').pop().toUpperCase().slice(0, 5) || 'FILE';
        // Layout minimalista: só o nome e a extensão. Sem tamanho, sem borda,
        // sem estilo de link. Fica com peso visual leve dentro do texto.
        dom.innerHTML =
          `<a class="kastor-att-card" href="${_escAttr(a.url || '#')}" target="_blank" rel="noopener">
             <div class="kastor-att-name">${_escAttr(a.name || 'arquivo')}</div>
             <div class="kastor-att-ext">${_escAttr(ext)}</div>
           </a>`;
      }
      return { dom };
    };
  },

  addCommands() {
    return {
      insertKastorAttachment: (att) => ({ chain }) => chain().focus().insertContent({
        type: 'kastorAttachment',
        attrs: {
          attachmentId: att.attachmentId || att.id || null,
          name: att.name || '',
          mime: att.mime || att.type || '',
          url: att.url || '',
          size: att.size || 0,
          kind: att.kind || 'file',
          isImage: !!(att.isImage || /^image\//i.test(att.mime || att.type || ''))
        }
      }).createParagraphNear().run()
    };
  }
});

/* ───────────────────────────────────────────────────────────────
   Extension: PasteAsLink
   ─────────────────────────────
   Se o user cola uma URL enquanto tem texto selecionado, transforma
   a seleção num link com aquela URL — em vez de substituir pelo texto
   da URL. Padrão Google Docs / Notion.
   ─────────────────────────────────────────────────────────────── */
const URL_REGEX = /^https?:\/\/[^\s]+$/i;
const PasteAsLink = Extension.create({
  name: 'kastorPasteAsLink',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData && event.clipboardData.getData('text/plain');
            if (!text) return false;
            const trimmed = text.trim();
            if (!URL_REGEX.test(trimmed)) return false;
            const { from, to, empty } = view.state.selection;
            if (empty) return false; // sem seleção, comportamento padrão (cola URL)
            const markType = view.state.schema.marks.link;
            if (!markType) return false;
            event.preventDefault();
            const tr = view.state.tr.addMark(from, to, markType.create({ href: trimmed }));
            view.dispatch(tr);
            return true;
          }
        }
      })
    ];
  }
});

/* ───────────────────────────────────────────────────────────────
   Mark customizado: kastorComment
   ─────────────────────────────
   Highlight amarelo suave que ancora um thread de comentário. O attr
   `data-thread-id` casa 1:1 com uma thread no back-end. Click no mark
   emite um CustomEvent('kastor-comment-click', { threadId }) que o
   standalone.js escuta pra abrir o painel na thread certa.
   ─────────────────────────────────────────────────────────────── */
const KastorComment = Mark.create({
  name: 'kastorComment',
  inclusive: false,      // não estende ao digitar fora do range
  // NOTA: omitir `excludes` (default é auto-exclusão do mesmo mark type).
  // Se colocar `excludes: ''` (overlapping), o y-prosemirror serializa o
  // attribute como `kastorComment--<hash>` na Y.XmlText — a chave tem `--`
  // que causa colisão no round-trip e y-prosemirror deleta o texto inteiro.
  addOptions() { return { HTMLAttributes: {} }; },

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: e => e.getAttribute('data-thread-id'),
        renderHTML: a => a.threadId ? { 'data-thread-id': a.threadId } : {}
      }
    };
  },

  parseHTML() { return [{ tag: 'span[data-thread-id]' }]; },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: 'kastor-comment-mark' }), 0];
  },

  addCommands() {
    return {
      setKastorComment: (threadId) => ({ chain }) =>
        chain().setMark(this.name, { threadId }).run(),
      unsetKastorComment: () => ({ chain }) =>
        chain().unsetMark(this.name).run(),
      unsetKastorCommentById: (threadId) => ({ tr, state, dispatch }) => {
        // Percorre o doc e remove marks com esse threadId
        let changed = false;
        state.doc.descendants((node, pos) => {
          const m = node.marks.find(mk => mk.type.name === 'kastorComment' && mk.attrs.threadId === threadId);
          if (m) {
            tr.removeMark(pos, pos + node.nodeSize, m);
            changed = true;
          }
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      }
    };
  }
});

function _escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function _fmtSize(bytes) {
  if (!bytes) return '—';
  const u = ['B','KB','MB','GB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

// Helper: extrai o Schema ProseMirror do editor pra usar em prosemirrorJSONToYDoc
// (precisamos do schema real, não recriar). Cria um editor temporário só pra pegar.
let _cachedSchema = null;
function _schemaFromExtensions() {
  if (_cachedSchema) return _cachedSchema;
  const tmpMount = document.createElement('div');
  const tmpEditor = new Editor({ element: tmpMount, extensions: kdExtensions({ schemaOnly: true }) });
  _cachedSchema = tmpEditor.schema;
  tmpEditor.destroy();
  return _cachedSchema;
}


/* ── Linha de tabela com altura (arrastar a borda de baixo) ──────────── */
const KdTableRow = TableRow.extend({
  addAttributes() {
    return {
      ...(this.parent?.() || {}),
      height: {
        default: null,
        parseHTML: (el) => parseInt(el.style.height, 10) || null,
        renderHTML: (a) => a.height ? { style: 'height:' + a.height + 'px' } : {}
      }
    };
  }
});

/* ── Espaçamento entre linhas (parágrafo/título) ─────────────────────── */
const KdLineHeight = Extension.create({
  name: 'kdLineHeight',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => el.style.lineHeight || null,
          renderHTML: (a) => a.lineHeight ? { style: 'line-height:' + a.lineHeight } : {}
        }
      }
    }];
  },
  addCommands() {
    return {
      setLineHeight: (value) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, lineHeight: value || null });
            changed = true;
          }
        });
        return changed;
      }
    };
  }
});

/* ── Sobrescrito / subscrito (exclusivos entre si) ────────────────────── */
const KdSubscript = Mark.create({
  name: 'subscript',
  excludes: 'superscript',
  parseHTML() { return [{ tag: 'sub' }, { style: 'vertical-align', getAttrs: v => v === 'sub' ? null : false }]; },
  renderHTML({ HTMLAttributes }) { return ['sub', mergeAttributes(HTMLAttributes), 0]; },
  addCommands() { return { toggleSubscript: () => ({ commands }) => commands.toggleMark(this.name) }; },
  addKeyboardShortcuts() { return { 'Mod-,': () => this.editor.commands.toggleSubscript() }; }
});
const KdSuperscript = Mark.create({
  name: 'superscript',
  excludes: 'subscript',
  parseHTML() { return [{ tag: 'sup' }, { style: 'vertical-align', getAttrs: v => v === 'super' ? null : false }]; },
  renderHTML({ HTMLAttributes }) { return ['sup', mergeAttributes(HTMLAttributes), 0]; },
  addCommands() { return { toggleSuperscript: () => ({ commands }) => commands.toggleMark(this.name) }; },
  addKeyboardShortcuts() { return { 'Mod-.': () => this.editor.commands.toggleSuperscript() }; }
});

/* ── Quebra de página ────────────────────────────────────────────────────
   Bloco atômico. Na tela a paginação empurra o bloco seguinte pra próxima
   folha; no PDF/impressão vira page-break-after. */
const KdPageBreak = Node.create({
  name: 'kdPageBreak',
  priority: 200,         // atalhos (Backspace/Delete) antes dos do núcleo (100)
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() { return [{ tag: 'div[data-page-break]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-break': 'true', class: 'kd-page-break' })];
  },
  addCommands() {
    return {
      /* Como no Word: Ctrl+Enter no meio do texto divide o parágrafo e o que
         vem depois do cursor começa na folha seguinte (sem linha vazia extra). */
      setPageBreak: () => ({ state, chain }) => {
        const { $from, empty } = state.selection;
        if (!empty || $from.depth !== 1 || !$from.parent.isTextblock) {
          return chain().insertContent({ type: this.name }).createParagraphNear().run();
        }
        if ($from.parentOffset === 0) {
          return chain().insertContentAt($from.before(1), { type: this.name }).run();
        }
        if ($from.parentOffset === $from.parent.content.size) {
          const after = $from.after(1);
          return chain().insertContentAt(after, [{ type: this.name }, { type: 'paragraph' }])
            .setTextSelection(after + 2).run();
        }
        return chain().splitBlock().command(({ tr }) => {
          const pos = tr.selection.$from.before(1);
          tr.insert(pos, state.schema.nodes[this.name].create());
          return true;
        }).run();
      }
    };
  },
  addKeyboardShortcuts() {
    const doc = () => this.editor.state.doc;
    // Primeiro filho em toda a cadeia até o bloco de nível 1 (início "visual")
    const atBlockStart = ($f) => { if ($f.parentOffset !== 0 || $f.depth < 1) return false; for (let d = 1; d < $f.depth; d++) if ($f.index(d) !== 0) return false; return true; };
    const atBlockEnd = ($f) => { if ($f.parentOffset !== $f.parent.content.size || $f.depth < 1) return false; for (let d = 1; d < $f.depth; d++) if ($f.index(d) !== $f.node(d).childCount - 1) return false; return true; };
    return {
      'Mod-Enter': () => this.editor.commands.setPageBreak(),
      // Backspace no começo da folha seguinte apaga a quebra (não junta blocos)
      Backspace: () => {
        const { $from, empty } = this.editor.state.selection;
        if (!empty || !atBlockStart($from)) return false;
        const idx = $from.index(0);
        if (idx === 0 || doc().child(idx - 1).type.name !== this.name) return false;
        const start = $from.before(1) - doc().child(idx - 1).nodeSize;
        return this.editor.chain().deleteRange({ from: start, to: $from.before(1) }).run();
      },
      // Delete no fim do bloco antes da quebra também apaga só a quebra
      Delete: () => {
        const { $from, empty } = this.editor.state.selection;
        if (!empty || !atBlockEnd($from)) return false;
        const idx = $from.index(0);
        if (idx >= doc().childCount - 1 || doc().child(idx + 1).type.name !== this.name) return false;
        const start = $from.after(1);
        return this.editor.chain().deleteRange({ from: start, to: start + doc().child(idx + 1).nodeSize }).run();
      }
    };
  }
});

/* ── Buscar e substituir ─────────────────────────────────────────────────
   Guarda o termo no storage da extensão e pinta os resultados com
   decorações (não mexe no documento). Busca dentro de cada bloco de texto,
   ignorando maiúsculas; o índice do resultado atual fica em storage.index. */
const kdSearchKey = new PluginKey('kdSearch');
function _kdFindAll(doc, term, caseSensitive) {
  const out = [];
  if (!term) return out;
  const needle = caseSensitive ? term : term.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    node.forEach(child => { text += child.isText ? child.text : '￼'; });
    const hay = caseSensitive ? text : text.toLowerCase();
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push({ from: pos + 1 + i, to: pos + 1 + i + needle.length });
      i = hay.indexOf(needle, i + needle.length);
    }
    return false;
  });
  return out;
}
const KdSearch = Extension.create({
  name: 'kdSearch',
  addStorage() { return { term: '', caseSensitive: false, results: [], index: 0 }; },
  addCommands() {
    const refresh = (tr, dispatch) => { if (dispatch) dispatch(tr.setMeta(kdSearchKey, true)); return true; };
    return {
      setSearchTerm: (term, caseSensitive) => ({ tr, dispatch }) => {
        this.storage.term = String(term || '');
        if (caseSensitive != null) this.storage.caseSensitive = !!caseSensitive;
        this.storage.index = 0;
        return refresh(tr, dispatch);
      },
      searchStep: (dir) => ({ tr, dispatch }) => {
        const n = this.storage.results.length;
        if (!n) return false;
        this.storage.index = (this.storage.index + (dir < 0 ? -1 : 1) + n) % n;
        return refresh(tr, dispatch);
      },
      replaceCurrent: (text) => ({ tr, dispatch }) => {
        const r = this.storage.results[this.storage.index];
        if (!r) return false;
        if (dispatch) {
          if (text) tr.insertText(text, r.from, r.to); else tr.delete(r.from, r.to);
          dispatch(tr.setMeta(kdSearchKey, true));
        }
        return true;
      },
      replaceAll: (text) => ({ tr, dispatch }) => {
        const list = this.storage.results.slice().reverse();
        if (!list.length) return false;
        if (dispatch) {
          for (const r of list) { if (text) tr.insertText(text, r.from, r.to); else tr.delete(r.from, r.to); }
          dispatch(tr.setMeta(kdSearchKey, true));
        }
        return true;
      }
    };
  },
  addProseMirrorPlugins() {
    const ext = this;
    return [new Plugin({
      key: kdSearchKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, old, _prev, state) {
          const st = ext.storage;
          if (!st.term) { st.results = []; return DecorationSet.empty; }
          if (!tr.docChanged && !tr.getMeta(kdSearchKey)) return old;
          st.results = _kdFindAll(state.doc, st.term, st.caseSensitive);
          if (st.index >= st.results.length) st.index = 0;
          return DecorationSet.create(state.doc, st.results.map((r, i) =>
            Decoration.inline(r.from, r.to, { class: i === st.index ? 'kd-find-hit is-current' : 'kd-find-hit' })));
        }
      },
      props: { decorations(state) { return kdSearchKey.getState(state); } }
    })];
  }
});

/* ── Referência à plataforma (#demanda, #cliente, #projeto) ───────────────
   Chip inline que aponta pra uma entidade do reWork. O documento guarda só
   tipo + id + nome no momento da inserção; o status/cor ao vivo vem de
   window.kdRefResolve (populado pelo standalone.js com os dados do app). */
const KdReference = Node.create({
  name: 'kdRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      kind:  { default: 'demand', parseHTML: e => e.getAttribute('data-kd-ref'),   renderHTML: a => ({ 'data-kd-ref': a.kind }) },
      refId: { default: null,     parseHTML: e => e.getAttribute('data-ref-id'),   renderHTML: a => ({ 'data-ref-id': a.refId }) },
      label: { default: '',       parseHTML: e => e.getAttribute('data-label') || e.textContent, renderHTML: a => ({ 'data-label': a.label }) }
    };
  },
  parseHTML() { return [{ tag: 'span[data-kd-ref]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'kd-ref kd-ref--' + node.attrs.kind }), '#' + (node.attrs.label || '')];
  },
  renderText({ node }) { return '#' + (node.attrs.label || ''); },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      const a = node.attrs;
      const info = (typeof window !== 'undefined' && typeof window.kdRefResolve === 'function')
        ? (window.kdRefResolve(a.kind, a.refId) || null) : null;
      dom.className = 'kd-ref kd-ref--' + a.kind + (info ? '' : ' is-missing') + (info && info.done ? ' is-done' : '');
      dom.setAttribute('data-kd-ref', a.kind);
      dom.setAttribute('data-ref-id', a.refId || '');
      dom.setAttribute('data-label', a.label || '');
      dom.contentEditable = 'false';
      const label = (info && info.label) || a.label || 'Item removido';
      dom.title = info ? [info.kindLabel, info.label, info.sub].filter(Boolean).join(' · ') : 'Não encontrado na plataforma';
      dom.innerHTML =
        `<span class="kd-ref-dot" style="background:${_escAttr((info && info.color) || '#9ca3af')}"></span>` +
        `<span class="kd-ref-label">${_escAttr(label)}</span>` +
        (info && info.status ? `<span class="kd-ref-status">${_escAttr(info.status)}</span>` : '');
      dom.addEventListener('click', (e) => {
        if (!info || !info.href) return;
        e.preventDefault();
        window.open(info.href, '_blank', 'noopener');
      });
      return { dom };
    };
  }
});

/* Popup genérico das sugestões (@menção, #referência, /comando). `rowHTML`
   desenha cada item; `pick(item, command)` executa a escolha. Itens com
   `group` ganham um cabeçalho de seção quando o grupo muda. */
function _kdSuggestRenderer({ className, empty, rowHTML, pick }) {
  return () => {
    let popup = null, selectedIndex = 0, items = [], command = null;
    const draw = () => {
      if (!popup) return;
      if (!items.length) { popup.innerHTML = `<div class="kd-suggest-empty">${empty}</div>`; return; }
      let html = '', lastGroup = null;
      items.forEach((it, i) => {
        if (it.group && it.group !== lastGroup) { html += `<div class="kd-suggest-group">${escapeHtml(it.group)}</div>`; lastGroup = it.group; }
        html += `<button type="button" data-i="${i}" class="kd-suggest-item${i === selectedIndex ? ' is-selected' : ''}">${rowHTML(it)}</button>`;
      });
      popup.innerHTML = html;
      popup.querySelector('.kd-suggest-item.is-selected')?.scrollIntoView({ block: 'nearest' });
    };
    const paintSel = () => {
      popup?.querySelectorAll('.kd-suggest-item').forEach((el, i) => el.classList.toggle('is-selected', i === selectedIndex));
      popup?.querySelector('.kd-suggest-item.is-selected')?.scrollIntoView({ block: 'nearest' });
    };
    const position = (props) => {
      const rect = props?.clientRect?.();
      if (!popup || !rect) return;
      const pw = popup.offsetWidth || 300, ph = popup.offsetHeight || 320;
      let x = rect.left, y = rect.bottom + 6;
      if (x + pw > window.innerWidth - 8) x = window.innerWidth - pw - 8;
      if (y + ph > window.innerHeight - 8) y = Math.max(8, rect.top - ph - 6);
      popup.style.left = x + 'px'; popup.style.top = y + 'px';
    };
    const run = (i) => { const it = items[i]; if (!it || !command) return false; try { pick(it, command); } catch (e) { console.error('[suggest]', e); } return true; };
    return {
      onStart: (props) => {
        popup = document.createElement('div');
        popup.className = 'kd-suggest ' + className;
        document.body.appendChild(popup);
        items = props.items || []; selectedIndex = 0; command = props.command;
        draw(); position(props);
        popup.addEventListener('pointerdown', (e) => {
          const el = e.target.closest('.kd-suggest-item'); if (!el) return;
          e.preventDefault(); e.stopPropagation(); run(Number(el.dataset.i));
        });
        popup.addEventListener('mousemove', (e) => {
          const el = e.target.closest('.kd-suggest-item'); if (!el) return;
          const i = Number(el.dataset.i); if (i !== selectedIndex) { selectedIndex = i; paintSel(); }
        });
      },
      onUpdate: (props) => {
        items = props.items || []; command = props.command;
        selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));
        // Sem resultado depois de um espaço = a pessoa só está escrevendo
        // (ex.: "#1 da lista"): esconde o popup em vez de insistir.
        if (popup) popup.hidden = !items.length && /\s/.test(props.query || '');
        draw(); position(props);
      },
      onKeyDown: ({ event }) => {
        if (!popup || popup.hidden) return false;
        if (event.key === 'ArrowDown') { if (items.length) { selectedIndex = (selectedIndex + 1) % items.length; paintSel(); } return true; }
        if (event.key === 'ArrowUp') { if (items.length) { selectedIndex = (selectedIndex - 1 + items.length) % items.length; paintSel(); } return true; }
        if (event.key === 'Enter' || event.key === 'Tab') return run(selectedIndex);
        if (event.key === 'Escape') { popup.remove(); popup = null; return true; }
        return false;
      },
      onExit: () => { popup?.remove(); popup = null; items = []; command = null; }
    };
  };
}

// Namespace global exposto pro app.js legado

/* ── KdImage: extende Image com width + align ─────────────────────────
   TipTap's Image não tem esses attrs por padrão. Adicionamos aqui pra
   permitir resize via handles/right-click e alinhamento (left/center/right).
   width pode ser número (px) ou string ("50%"), renderizado no style. */
const KdImage = Image.extend({
  addAttributes() {
    return {
      ...(this.parent?.() || {}),
      width: {
        default: null,
        renderHTML: (attrs) => {
          if (attrs.width == null || attrs.width === '') return {};
          const v = typeof attrs.width === 'number' ? attrs.width + 'px' : String(attrs.width);
          return { style: 'width:' + v };
        },
        parseHTML: (el) => {
          const w = el.getAttribute('width') || (el.style && el.style.width) || '';
          if (!w) return null;
          if (w.endsWith('%')) return w;
          const n = parseInt(w, 10);
          return Number.isFinite(n) ? n : null;
        }
      },
      align: {
        default: null,
        renderHTML: (attrs) => attrs.align ? { 'data-align': attrs.align } : {},
        parseHTML: (el) => el.getAttribute('data-align') || null
      }
    };
  }
});

/* ── Callout: bloco de destaque (Nota/Aviso/Dica/Importante) ────────
   Container com background colorido + ícone + conteúdo editável.
   Cor/ícone vêm do attr `variant` (info/warn/tip/danger). Renderiza
   como <div class="kd-callout kd-callout--warn">. Aceita qualquer bloco
   dentro (parágrafos, listas, etc). Fica GROUP block pra permitir mistura. */
const KdCallout = Node.create({
  name: 'kdCallout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      variant: {
        default: 'info',
        parseHTML: (el) => el.getAttribute('data-variant') || 'info',
        renderHTML: (attrs) => ({ 'data-variant': attrs.variant || 'info' })
      }
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': 'true', class: 'kd-callout' }), 0];
  },
  addCommands() {
    return {
      setCallout: (attrs = {}) => ({ commands }) => {
        return commands.wrapIn(this.name, { variant: attrs.variant || 'info' });
      },
      unsetCallout: () => ({ commands }) => commands.lift(this.name),
      toggleCallout: (attrs = {}) => ({ state, commands }) => {
        const isInCallout = state.selection.$from.node(-1)?.type.name === this.name
                         || state.selection.$from.parent.type.name === this.name;
        return isInCallout ? commands.lift(this.name) : commands.wrapIn(this.name, { variant: attrs.variant || 'info' });
      }
    };
  }
});

/* ── Colunas: bloco container multi-coluna (2 ou 3 colunas) ─────────
   kdColumnBlock = wrapper com N .kd-column dentro.
   kdColumn      = célula editável (aceita blocos).
   Renderiza como CSS grid. Attr `cols` controla número de colunas.
   Ao inserir, cria automaticamente N kdColumn com um parágrafo vazio cada. */
const KdColumn = Node.create({
  name: 'kdColumn',
  group: 'kdColumn',
  content: 'block+',
  defining: true,
  isolating: true,
  parseHTML() { return [{ tag: 'div[data-column]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column': 'true', class: 'kd-column' }), 0];
  }
});
const KdColumnBlock = Node.create({
  name: 'kdColumnBlock',
  group: 'block',
  content: 'kdColumn{2,3}',       // exige 2 ou 3 kdColumns
  addAttributes() {
    return {
      cols: {
        default: 2,
        parseHTML: (el) => parseInt(el.getAttribute('data-cols') || '2', 10),
        renderHTML: (attrs) => ({ 'data-cols': String(attrs.cols || 2), style: 'grid-template-columns: repeat(' + (attrs.cols || 2) + ', 1fr)' })
      }
    };
  },
  parseHTML() { return [{ tag: 'div[data-column-block]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column-block': 'true', class: 'kd-column-block' }), 0];
  },
  addCommands() {
    return {
      setColumns: (n = 2) => ({ commands }) => {
        const cols = Math.max(2, Math.min(3, Number(n) || 2));
        const kdCol = { type: 'kdColumn', content: [{ type: 'paragraph' }] };
        // commands.insertContent evita quebrar a chain externa (que às vezes
        // vem via slash command: chain().deleteRange().setColumns().run()).
        return commands.insertContent({
          type: 'kdColumnBlock',
          attrs: { cols },
          content: new Array(cols).fill(null).map(() => kdCol)
        });
      }
    };
  }
});

/* ── Mention: renderiza @nome como chip clicável ──────────────────── */
const KdMentionSuggestion = {
  char: '@',
  allowSpaces: false,
  items: ({ query }) => {
    // Lista de pessoas vem do standalone.js (window.kdMentionItems)
    if (typeof window !== 'undefined' && typeof window.kdMentionItems === 'function') {
      try { return (window.kdMentionItems(query) || []).slice(0, 8); } catch { return []; }
    }
    return [];
  },
  render: _kdSuggestRenderer({
    className: 'kd-suggest--people',
    empty: 'Ninguém com esse nome',
    rowHTML: (it) => (it.avatar
      ? `<img src="${_escAttr(it.avatar)}" alt="" class="kd-suggest-avatar">`
      : `<span class="kd-suggest-avatar" style="background:${_escAttr(it.color || '#7A00FF')}">${escapeHtml((it.name || '?').charAt(0).toUpperCase())}</span>`)
      + `<span class="kd-suggest-text"><span class="kd-suggest-title">${escapeHtml(it.name || '')}</span>${it.role ? `<span class="kd-suggest-sub">${escapeHtml(it.role)}</span>` : ''}</span>`,
    pick: (it, command) => command({ id: it.id, label: it.name })
  })
};
const KdMention = Mention.configure({
  HTMLAttributes: { class: 'kd-mention' },
  renderText: ({ node }) => `@${node.attrs.label || node.attrs.id}`,
  suggestion: KdMentionSuggestion
});

/* ── # referência: demandas, clientes e projetos da plataforma ─────── */
const kdRefPluginKey = new PluginKey('kdRefSuggest');
const KdRefSuggest = Extension.create({
  name: 'kdRefSuggest',
  addProseMirrorPlugins() {
    return [Suggestion({
      editor: this.editor,
      pluginKey: kdRefPluginKey,
      char: '#',
      allowSpaces: true,
      items: ({ query }) => {
        if (typeof window === 'undefined' || typeof window.kdRefItems !== 'function') return [];
        try { return window.kdRefItems(query) || []; } catch { return []; }
      },
      command: ({ editor, range, props }) => {
        editor.chain().focus().insertContentAt(range, [
          { type: 'kdRef', attrs: { kind: props.kind, refId: props.id, label: props.label } },
          { type: 'text', text: ' ' }
        ]).run();
      },
      render: _kdSuggestRenderer({
        className: 'kd-suggest--refs',
        empty: 'Nada encontrado na plataforma',
        rowHTML: (it) => `<span class="kd-suggest-dot" style="background:${_escAttr(it.color || '#9ca3af')}"></span>`
          + `<span class="kd-suggest-text"><span class="kd-suggest-title">${escapeHtml(it.label)}</span>${it.sub ? `<span class="kd-suggest-sub">${escapeHtml(it.sub)}</span>` : ''}</span>`
          + (it.status ? `<span class="kd-suggest-meta">${escapeHtml(it.status)}</span>` : ''),
        pick: (it, command) => command(it)
      })
    })];
  }
});

/* ── Slash command: menu contextual em `/` pra inserir bloco ────────
   Reusa @tiptap/suggestion (mesma libs do Mention). Ao digitar `/`,
   abre popup com lista de comandos (heading, list, callout, table…).
   Executor de cada comando fica no `command` do item. */
/* Match query contra um comando. Query pode ter múltiplos tokens (separados
   por espaço) e cada token precisa aparecer em algum lugar (title, keyword
   individual, ou title+keywords concatenados). Substring match, sem regex. */
const _kdNorm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function _matchSlash(query, cmd) {
  const q = _kdNorm(query).trim();
  if (!q) return true;
  const haystack = _kdNorm(cmd.title + ' ' + (cmd.keywords || []).join(' '));
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.every(t => haystack.includes(t));
}
const _SI = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const KD_SLASH_ICONS = {
  text:  _SI('<path d="M4 7V4h16v3M9 20h6M12 4v16"/>'),
  h:     (n) => `<span class="kd-slash-h">H${n}</span>`,
  ul:    _SI('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  ol:    _SI('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
  task:  _SI('<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3.5 17 2 2 4-4"/><line x1="13" y1="8" x2="21" y2="8"/><line x1="13" y1="17" x2="21" y2="17"/>'),
  quote: _SI('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>'),
  code:  _SI('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  hr:    _SI('<line x1="3" y1="12" x2="21" y2="12"/>'),
  table: _SI('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>'),
  info:  _SI('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  tip:   _SI('<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
  warn:  _SI('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  danger:_SI('<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
  cols:  _SI('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>'),
  cols3: _SI('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>'),
  image: _SI('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
  clip:  _SI('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  page:  _SI('<path d="M4 4h16v6H4zM4 14h16v6H4z" stroke-dasharray="2 2"/>'),
  date:  _SI('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  ref:   _SI('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
  at:    _SI('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>')
};
const _hook = (name, ...args) => { try { window.kdEditorHooks?.[name]?.(...args); } catch (e) { console.error('[slash hook]', name, e); } };
const KdSlashCommands = [
  { group: 'Texto', key: 'p',  title: 'Texto',            desc: 'Parágrafo comum',                 keywords: ['p','paragrafo','texto','normal'], icon: KD_SLASH_ICONS.text, run: (ed, r) => ed.chain().focus().deleteRange(r).setParagraph().run() },
  { group: 'Texto', key: 'h1', title: 'Título 1',         desc: 'Seção principal',                 keywords: ['h1','titulo','heading'],         icon: KD_SLASH_ICONS.h(1), run: (ed, r) => ed.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run() },
  { group: 'Texto', key: 'h2', title: 'Título 2',         desc: 'Subseção',                        keywords: ['h2','titulo','subtitulo'],       icon: KD_SLASH_ICONS.h(2), run: (ed, r) => ed.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run() },
  { group: 'Texto', key: 'h3', title: 'Título 3',         desc: 'Tópico dentro da subseção',       keywords: ['h3','titulo'],                   icon: KD_SLASH_ICONS.h(3), run: (ed, r) => ed.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run() },
  { group: 'Texto', key: 'h4', title: 'Título 4',         desc: 'Detalhe',                         keywords: ['h4','titulo'],                   icon: KD_SLASH_ICONS.h(4), run: (ed, r) => ed.chain().focus().deleteRange(r).setNode('heading', { level: 4 }).run() },
  { group: 'Listas', key: 'ul', title: 'Lista com marcadores', desc: 'Tópicos simples',            keywords: ['lista','bullet','ul','marcadores'], icon: KD_SLASH_ICONS.ul, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleBulletList().run() },
  { group: 'Listas', key: 'ol', title: 'Lista numerada',  desc: 'Passos em ordem',                 keywords: ['numerada','ordenada','ol','1'],  icon: KD_SLASH_ICONS.ol, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { group: 'Listas', key: 'task', title: 'Lista de tarefas', desc: 'Itens pra marcar como feitos', keywords: ['todo','task','checkbox','tarefa','checklist'], icon: KD_SLASH_ICONS.task, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleTaskList().run() },
  { group: 'Plataforma', key: 'ref', title: 'Demanda, cliente ou projeto', desc: 'Liga o texto ao trabalho no reWork', keywords: ['demanda','cliente','projeto','referencia','#','link'], icon: KD_SLASH_ICONS.ref, run: (ed, r) => ed.chain().focus().deleteRange(r).insertContent('#').run() },
  { group: 'Plataforma', key: 'mention', title: 'Mencionar pessoa', desc: 'Avisa alguém da equipe', keywords: ['mencao','pessoa','@','usuario'], icon: KD_SLASH_ICONS.at, run: (ed, r) => ed.chain().focus().deleteRange(r).insertContent('@').run() },
  { group: 'Inserir', key: 'image', title: 'Imagem',      desc: 'Enviar do computador',            keywords: ['imagem','foto','upload','png','jpg'], icon: KD_SLASH_ICONS.image, run: (ed, r) => { ed.chain().focus().deleteRange(r).run(); _hook('uploadImage'); } },
  { group: 'Inserir', key: 'gallery', title: 'Arquivo da Galeria', desc: 'Anexar algo que já está na plataforma', keywords: ['galeria','anexo','arquivo'], icon: KD_SLASH_ICONS.clip, run: (ed, r) => { ed.chain().focus().deleteRange(r).run(); _hook('gallery'); } },
  { group: 'Inserir', key: 'table', title: 'Tabela',      desc: '3 × 3 com cabeçalho',             keywords: ['table','tabela','grade'],        icon: KD_SLASH_ICONS.table, run: (ed, r) => ed.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { group: 'Inserir', key: 'date', title: 'Data de hoje', desc: 'Insere a data atual',             keywords: ['data','hoje','dia'],             icon: KD_SLASH_ICONS.date, run: (ed, r) => ed.chain().focus().deleteRange(r).insertContent(new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) + ' ').run() },
  { group: 'Inserir', key: 'hr', title: 'Linha divisória', desc: 'Separa seções',                  keywords: ['hr','divisor','divisoria','separador','linha'], icon: KD_SLASH_ICONS.hr, run: (ed, r) => ed.chain().focus().deleteRange(r).setHorizontalRule().run() },
  { group: 'Inserir', key: 'pagebreak', title: 'Quebra de página', desc: 'Continua na próxima folha', keywords: ['quebra','pagina','page','break'], icon: KD_SLASH_ICONS.page, run: (ed, r) => ed.chain().focus().deleteRange(r).setPageBreak().run() },
  { group: 'Blocos', key: 'quote', title: 'Citação',      desc: 'Destaca uma fala ou trecho',      keywords: ['quote','citacao','blockquote'],  icon: KD_SLASH_ICONS.quote, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { group: 'Blocos', key: 'callout-info', title: 'Nota', desc: 'Caixa de informação',              keywords: ['nota','info','callout','caixa'], icon: KD_SLASH_ICONS.info, run: (ed, r) => ed.chain().focus().deleteRange(r).setCallout({ variant: 'info' }).run() },
  { group: 'Blocos', key: 'callout-tip', title: 'Dica',   desc: 'Sugestão ou boa prática',         keywords: ['dica','tip','callout'],          icon: KD_SLASH_ICONS.tip, run: (ed, r) => ed.chain().focus().deleteRange(r).setCallout({ variant: 'tip' }).run() },
  { group: 'Blocos', key: 'callout-warn', title: 'Aviso', desc: 'Ponto de atenção',                keywords: ['aviso','warn','atencao','callout'], icon: KD_SLASH_ICONS.warn, run: (ed, r) => ed.chain().focus().deleteRange(r).setCallout({ variant: 'warn' }).run() },
  { group: 'Blocos', key: 'callout-danger', title: 'Importante', desc: 'Algo que não pode passar', keywords: ['danger','importante','critico','callout'], icon: KD_SLASH_ICONS.danger, run: (ed, r) => ed.chain().focus().deleteRange(r).setCallout({ variant: 'danger' }).run() },
  { group: 'Blocos', key: 'cols2', title: '2 colunas',    desc: 'Texto lado a lado',               keywords: ['colunas','cols','2col'],         icon: KD_SLASH_ICONS.cols, run: (ed, r) => ed.chain().focus().deleteRange(r).setColumns(2).run() },
  { group: 'Blocos', key: 'cols3', title: '3 colunas',    desc: 'Três blocos lado a lado',         keywords: ['colunas','cols','3col'],         icon: KD_SLASH_ICONS.cols3, run: (ed, r) => ed.chain().focus().deleteRange(r).setColumns(3).run() },
  { group: 'Blocos', key: 'code', title: 'Bloco de código', desc: 'Com destaque de sintaxe',       keywords: ['code','codigo'],                 icon: KD_SLASH_ICONS.code, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleCodeBlock().run() }
];
const KdSlashCommand = Extension.create({
  name: 'kdSlashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        // Ativa quando `/` está no COMEÇO do parágrafo/heading atual — mas não
        // no meio de uma palavra (evita interromper `and/or`, `TCP/IP`).
        // Aceita em qualquer nível de profundidade (paragraph raiz, dentro
        // de callout, dentro de coluna, etc.), desde que o bloco imediato
        // aceite conteúdo de texto.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          // range.from é a posição pm do `/` (início do trigger).
          // parent.start() é a posição pm do primeiro char do bloco.
          // A diferença é o offset (em chars) do `/` dentro do bloco.
          const offset = range.from - $from.start();
          const beforeSlash = $from.parent.textContent.slice(0, offset);
          return beforeSlash.trim().length === 0;
        },
        items: ({ query }) => KdSlashCommands.filter(c => _matchSlash(query, c)),
        command: ({ editor, range, props }) => {
          try { props.run(editor, range); } catch (e) { console.error('[slash]', e); }
        },
        render: _kdSuggestRenderer({
          className: 'kd-suggest--slash',
          empty: 'Nenhum bloco com esse nome',
          rowHTML: (it) => `<span class="kd-suggest-icon">${it.icon}</span>`
            + `<span class="kd-suggest-text"><span class="kd-suggest-title">${escapeHtml(it.title)}</span><span class="kd-suggest-sub">${escapeHtml(it.desc || '')}</span></span>`,
          pick: (it, command) => command(it)
        })
      })
    ];
  }
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ── Indent (margens de parágrafo) ───────────────────────────────────
   Adiciona atributos `indentLeft` e `indentRight` (em mm) nos blocos
   (paragraph, heading, listas, blockquote). Renderizados como inline
   style: margin-left/right. Usados pela régua pra deslocar blocos. */
const KdBlockIndent = Extension.create({
  name: 'kdBlockIndent',
  addGlobalAttributes() {
    // Combina indent left/right + first-line indent num único `style`
    // (browsers ignoram atributos style múltiplos — precisa ser 1 string).
    const buildStyle = (a) => {
      const parts = [];
      if (a.indentLeft)       parts.push('margin-left:' + a.indentLeft + 'mm');
      if (a.indentRight)      parts.push('margin-right:' + a.indentRight + 'mm');
      if (a.firstLineIndent)  parts.push('text-indent:' + a.firstLineIndent + 'mm');
      return parts.length ? { style: parts.join(';') } : {};
    };
    return [{
      types: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote'],
      attributes: {
        indentLeft: {
          default: 0,
          renderHTML: buildStyle,
          parseHTML: (el) => {
            const m = parseFloat(el.style.marginLeft);
            return isFinite(m) ? Math.round(m * 10) / 10 : 0;
          }
        },
        indentRight: {
          default: 0,
          // Não renderiza standalone — buildStyle acima já foi chamado no primeiro attr
          renderHTML: () => ({}),
          parseHTML: (el) => {
            const m = parseFloat(el.style.marginRight);
            return isFinite(m) ? Math.round(m * 10) / 10 : 0;
          }
        },
        firstLineIndent: {
          default: 0,
          renderHTML: () => ({}),
          parseHTML: (el) => {
            const m = parseFloat(el.style.textIndent);
            return isFinite(m) ? Math.round(m * 10) / 10 : 0;
          }
        }
      }
    }];
  },
  addCommands() {
    return {
      setBlockIndent: (attrs) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection;
        const types = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote'];
        let modified = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (types.includes(node.type.name)) {
            const newAttrs = { ...node.attrs };
            if (attrs.indentLeft       != null) newAttrs.indentLeft       = Math.max(0, attrs.indentLeft);
            if (attrs.indentRight      != null) newAttrs.indentRight      = Math.max(0, attrs.indentRight);
            if (attrs.firstLineIndent  != null) newAttrs.firstLineIndent  = Math.max(0, attrs.firstLineIndent);
            if (dispatch) tr.setNodeMarkup(pos, undefined, newAttrs);
            modified = true;
            // Lista/citação recua como um bloco só: não desce pros parágrafos
            // de dentro (senão o recuo soma duas vezes).
            if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return false;
          }
        });
        return modified;
      }
    };
  }
});

/* ═══ Paginação (formato "Páginas") ═══════════════════════════════════
   Motor de páginas A4 sobre um único ProseMirror. Nada muda no documento:
   tudo é decoração.
     - "margin": margem no topo de um bloco pra ele começar na folha seguinte;
     - "gap":    espaço invisível dentro de um parágrafo, antes da primeira
                 linha que não coube (quebra na linha, como Word/Docs).

   Unidades de fluxo:
     - parágrafo/título → linhas (viúvas/órfãs: ≥ 2 linhas em cada folha);
     - item de lista → o marcador desce junto com o texto; itens aninhados
       são unidades próprias;
     - caixas (citação, nota, tabela, código, imagem, colunas…) → inteiras;
     - quebra de página → a próxima unidade abre folha nova;
     - título não fica sozinho no pé da página (vai junto com o seguinte).

   Roda num microtask logo depois de cada mudança — antes do navegador pintar,
   então o texto nunca aparece na margem pra depois "pular". É incremental:
   recomeça uma folha antes da mudança e para quando a paginação volta a
   bater com a anterior. */
const kdPagesKey = new PluginKey('kdPages');
const KD_TEXT_UNITS = new Set(['paragraph', 'heading']);
const KD_LIST_NODES = new Set(['bulletList', 'orderedList', 'taskList']);
const KD_ITEM_NODES = new Set(['listItem', 'taskItem']);

function _kdPushDeco(doc, p) {
  if (p.kind === 'gap') {
    const h = Math.max(0, Math.round(p.height));
    return Decoration.widget(p.pos, () => {
      const el = document.createElement('span');
      el.className = 'kd-page-gap';
      el.contentEditable = 'false';
      el.setAttribute('aria-hidden', 'true');
      el.style.height = h + 'px';
      return el;
    }, { side: -1, key: 'kdgap-' + h, ignoreSelection: true, kdPush: p });
  }
  const node = doc.nodeAt(p.pos);
  if (!node) return null;
  return Decoration.node(p.pos, p.pos + node.nodeSize, { style: 'margin-top:' + Math.round(p.margin) + 'px' }, { kdPush: p });
}
function _kdPagesSet(doc, pushes) {
  const decos = [];
  for (const p of pushes) { try { const d = _kdPushDeco(doc, p); if (d) decos.push(d); } catch (_) {} }
  return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

/* Unidades de fluxo na ordem do documento. Cada uma sabe o que empurrar
   quando precisa abrir folha (o próprio bloco, o item da lista — marcador
   junto — ou a lista inteira quando é o primeiro item). */
function _kdFlowUnits(view) {
  const units = [];
  const dom = (pos) => { const d = view.nodeDOM(pos); return d && d.nodeType === 1 ? d : null; };
  const add = (u) => { if (u.dom) units.push(u); };
  const walkList = (list, listPos, climbPos) => {
    list.forEach((item, off, idx) => {
      const itemPos = listPos + 1 + off;
      // Primeiro item: quem desce é a lista (senão a margem colapsa no pai)
      const pushPos = idx === 0 ? climbPos : itemPos;
      item.forEach((child, coff, cidx) => {
        const cpos = itemPos + 1 + coff;
        if (KD_LIST_NODES.has(child.type.name)) walkList(child, cpos, cpos);
        else if (child.isTextblock) add({ kind: 'text', pos: cpos, node: child, dom: dom(cpos), pushPos: cidx === 0 ? pushPos : cpos, heading: false });
        else add({ kind: 'box', pos: cpos, node: child, dom: dom(cpos), pushPos: cpos });
      });
    });
  };
  view.state.doc.forEach((node, pos) => {
    const t = node.type.name;
    if (t === 'kdPageBreak') units.push({ kind: 'break', pos, node });
    else if (KD_TEXT_UNITS.has(t)) add({ kind: 'text', pos, node, dom: dom(pos), pushPos: pos, heading: t === 'heading' });
    else if (KD_LIST_NODES.has(t)) walkList(node, pos, pos);
    else add({ kind: 'box', pos, node, dom: dom(pos), pushPos: pos });
  });
  return units;
}

/* Linhas de um bloco de texto: caixa da LINHA (glifos + meia entrelinha),
   posição do início de cada linha. Ignora o próprio espaço de paginação. */
function _kdLinesOf(view, dom, paperTop) {
  const cs = getComputedStyle(dom);
  let lh = parseFloat(cs.lineHeight);
  if (!(lh > 0)) lh = (parseFloat(cs.fontSize) || 14) * 1.2;
  const rects = [];
  const range = document.createRange();
  const tw = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      if (n.nodeType === 1) {
        if (n.classList.contains('kd-page-gap')) return NodeFilter.FILTER_REJECT;
        return (n.getAttribute('contenteditable') === 'false' || n.tagName === 'IMG' || n.tagName === 'BR') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  let n;
  while ((n = tw.nextNode())) {
    if (n.nodeType === 3) { range.selectNodeContents(n); for (const r of range.getClientRects()) if (r.height > 0) rects.push(r); }
    else if (n.tagName !== 'BR') { const r = n.getBoundingClientRect(); if (r.height > 0) rects.push(r); }
  }
  if (!rects.length) {
    const r = dom.getBoundingClientRect();
    return [{ top: r.top - paperTop, bottom: r.bottom - paperTop, left: r.left, mid: (r.top + r.bottom) / 2, pos: null }];
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    if (last && r.top < last.gb - 2 && r.bottom > last.gt + 2) {
      last.gt = Math.min(last.gt, r.top); last.gb = Math.max(last.gb, r.bottom); last.left = Math.min(last.left, r.left);
    } else lines.push({ gt: r.top, gb: r.bottom, left: r.left });
  }
  return lines.map(l => {
    const half = Math.max(0, (lh - (l.gb - l.gt)) / 2);
    return { top: l.gt - half - paperTop, bottom: l.gb + half - paperTop, left: l.left, mid: (l.gt + l.gb) / 2, pos: null };
  });
}

/* Linhas limpas de uma unidade de texto (sem o efeito dos empurrões) e a
   posição do início de cada uma — achada por busca binária nos caracteres
   (Range), bem mais rápido que posAtCoords. */
function _kdCleanLines(view, u, paperTop, effBefore) {
  const dom = u.dom;
  const widgets = [...dom.querySelectorAll('.kd-page-gap')].map(w => ({ top: w.getBoundingClientRect().top - paperTop, h: parseFloat(w.style.height) || 0 }));
  const shiftOf = (y) => effBefore + widgets.reduce((a, w) => a + (w.top < y - 1 ? w.h : 0), 0);
  const lines = _kdLinesOf(view, dom, paperTop);
  // Texto do bloco em ordem (ignora o próprio vão)
  const texts = [];
  const tw = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('.kd-page-gap')) || !n.nodeValue ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  let n; while ((n = tw.nextNode())) texts.push(n);
  const range = document.createRange();
  const charTop = (t, i) => { range.setStart(t, i); range.setEnd(t, i + 1); const r = range.getClientRects(); return r.length ? r[r.length - 1].top : range.getBoundingClientRect().top; };
  const startOf = (lineTopAbs) => {
    for (const t of texts) {
      const len = t.nodeValue.length;
      if (charTop(t, len - 1) < lineTopAbs) continue;              // texto todo acima
      let lo = 0, hi = len - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (charTop(t, mid) >= lineTopAbs) hi = mid; else lo = mid + 1; }
      try { return view.posAtDOM(t, lo); } catch { return null; }
    }
    return null;
  };
  return lines.map((l, k) => {
    // Vãos já aplicados acima desta linha, dentro do próprio bloco
    const shift = shiftOf(l.top);
    // 1ª posição cujo caractere começa nesta linha (topo da caixa da linha)
    const pos = k === 0 ? u.pos + 1 : startOf(l.top + paperTop - 0.5);
    return { top: l.top - shift, bottom: l.bottom - shift, left: l.left, pos };
  });
}

class KdPager {
  constructor(view, storage) {
    this.view = view;
    this.storage = storage;
    this.dirtyFrom = 0;
    this.dirtyTo = Infinity;     // fim do trecho alterado (no doc novo)
    this.scheduled = false;
    storage._pager = this;
    this.onLoad = (e) => { if (e.target && e.target.tagName === 'IMG') { try { this.schedule(view.posAtDOM(e.target, 0)); } catch { this.schedule(0); } } };
    view.dom.addEventListener('load', this.onLoad, true);
    this.onResize = () => this.schedule(0);
    window.addEventListener('resize', this.onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.schedule(0));
    this.schedule(0);
  }
  update(view, prev) {
    if (view.state.doc !== prev.doc) {
      const a = view.state.doc.content, b = prev.doc.content;
      const at = b.findDiffStart(a);
      const end = b.findDiffEnd(a);
      this.schedule(at == null ? 0 : at, end ? end.b : Infinity);
    }
  }
  destroy() {
    this.view.dom.removeEventListener('load', this.onLoad, true);
    window.removeEventListener('resize', this.onResize);
    if (this.storage._pager === this) this.storage._pager = null;
  }
  schedule(from, to) {
    this.dirtyFrom = Math.min(this.dirtyFrom, Math.max(0, from || 0));
    this.dirtyTo = (this.dirtyTo === -1) ? (to == null ? Infinity : to) : Math.max(this.dirtyTo, to == null ? Infinity : to);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.run());
  }
  commit(pushes, pages) {
    const st = kdPagesKey.getState(this.view.state);
    const same = st.pushes.length === pushes.length && st.pushes.every((p, i) =>
      p.kind === pushes[i].kind && p.pos === pushes[i].pos && (p.height || p.margin) === (pushes[i].height || pushes[i].margin));
    if (!same) {
      const doc = this.view.state.doc;
      this.view.dispatch(this.view.state.tr.setMeta(kdPagesKey, { decos: _kdPagesSet(doc, pushes), pushes, pages }).setMeta('addToHistory', false));
    } else {
      st.pages = pages;
    }
  }
  run() {
    this.scheduled = false;
    const view = this.view, storage = this.storage;
    if (view.isDestroyed) return;
    let st = kdPagesKey.getState(view.state);
    if (!storage.enabled) {
      this.dirtyFrom = Infinity; this.dirtyTo = -1;
      if (st.pushes.length) this.commit([], 1);
      storage.onLayout && storage.onLayout({ pages: 1, enabled: false });
      return;
    }
    if (view.composing) { setTimeout(() => this.schedule(0), 120); return; }
    const paper = view.dom.closest('.writer-editor-paper');
    if (!paper || !paper.offsetHeight) { this.dirtyFrom = Infinity; this.dirtyTo = -1; return; }
    const from = this.dirtyFrom, to = this.dirtyTo;
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;

    // Geometria da folha
    const cs = getComputedStyle(paper);
    const H = storage.pageHeight, G = storage.pageGap;
    const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
    const pageStart = (i) => i * (H + G) + padT;
    const pageEnd = (i) => i * (H + G) + H - padB;
    const usable = H - padT - padB;
    const doc = view.state.doc;

    /* Os empurrões atuais ficam no lugar; a posição "limpa" (sem eles) é a
       medida menos o deslocamento de cada um — exato pros vãos (a altura) e
       pras margens (margem − espaço natural, guardado ao criar). A margem
       só perde a validade se a edição mexeu no bloco empurrado ou no
       anterior a ele: essas saem antes de medir. */
    let old = st.pushes;
    const touched = (p) => {
      if (p.kind !== 'margin') return false;
      const node = doc.nodeAt(p.pos);
      if (!node) return true;
      const $p = doc.resolve(p.pos);
      const idx = $p.index();
      const prevStart = idx > 0 ? p.pos - $p.parent.child(idx - 1).nodeSize : p.pos;
      return from <= p.pos + node.nodeSize && to + 1 >= prevStart;
    };
    const forced = this.forceUntrusted; this.forceUntrusted = null;
    const untrusted = old.filter(p => touched(p) || p.pos === forced);
    if (untrusted.length) {
      old = old.filter(p => !untrusted.includes(p));
      this.commit(old, st.pages);
      st = kdPagesKey.getState(view.state);
    }
    const effTop = (pos) => {
      let e = 0;
      for (const p of old) { if (p.pos > pos) break; if (p.kind === 'margin' ? p.pos <= pos : p.pos < pos) e += p.effect; }
      return e;
    };
    const effInside = (a_, b_) => {
      let e = 0;
      for (const p of old) { if (p.kind === 'gap' && p.pos > a_ && p.pos < b_) e += p.effect; }
      return e;
    };

    // Recomeça uma folha antes da mudança (viúvas/órfãs/títulos dependem dela)
    let keep = 0;
    for (let i = 0; i < old.length; i++) { if (old[i].pos < from) keep = i + 1; else break; }
    keep = Math.max(0, keep - 1);
    const kept = old.slice(0, keep);
    const stale = old.slice(keep);
    const restartPos = kept.length ? kept[kept.length - 1].pos : -1;
    let page = kept.length ? kept[kept.length - 1].page : 0;
    let offset = kept.reduce((a_, p) => a_ + p.effect, 0);

    const paperTop = paper.getBoundingClientRect().top;
    const units = _kdFlowUnits(view);
    const pushes = kept.slice();
    const moved = new Set();
    let forceNext = false, converged = false;
    const domOf = (pos) => { const d = view.nodeDOM(pos); return d && d.nodeType === 1 ? d : null; };
    const cleanRect = (u) => {
      const r = u.dom.getBoundingClientRect();
      const t = effTop(u.pos);
      return { top: r.top - paperTop - t, bottom: r.bottom - paperTop - t - effInside(u.pos, u.pos + u.node.nodeSize) };
    };
    const addPush = (p) => {
      // Quebra idêntica (mesmo lugar e folha) depois do trecho alterado: o
      // resto do documento fica como estava.
      const same = p.pos > to && stale.find(o => o.pos === p.pos && o.page === p.page && o.kind === p.kind);
      pushes.push(p);
      if (same) { for (const o of stale) if (o.pos > p.pos) pushes.push(o); converged = true; }
    };
    const pushUnit = (u) => {
      const el = domOf(u.pushPos) || u.dom;
      const top = el.getBoundingClientRect().top - paperTop - effTop(u.pushPos) + offset;
      const amount = pageStart(page + 1) - top;
      page++;
      if (amount <= 0) return;
      // Espaço natural (margens colapsadas) entre o bloco e o anterior, medido
      // agora — sem empurrão nesse bloco (os tocados já saíram).
      const prev = el.previousElementSibling;
      const own = old.find(p => p.kind === 'margin' && p.pos === u.pushPos);
      const natural = own ? own.natural
        : prev ? Math.max(0, el.getBoundingClientRect().top - prev.getBoundingClientRect().bottom)
        : (parseFloat(getComputedStyle(el).marginTop) || 0);
      const margin = Math.round(natural + amount);
      const effect = margin - natural;
      offset += effect;
      moved.add(u);
      addPush({ kind: 'margin', pos: u.pushPos, margin, natural, effect, page });
    };
    const pushWithKeep = (idx) => {
      let j = idx - 1;
      while (j >= 0 && units[j].kind === 'text' && units[j].heading && !moved.has(units[j]) &&
             cleanRect(units[j]).top + offset > pageStart(page) + 1 && units[j].pos > restartPos) j--;
      pushUnit(j + 1 < idx ? units[j + 1] : units[idx]);
    };

    let lastUnit = null;
    for (let i = 0; i < units.length && !converged; i++) {
      const u = units[i];
      if (u.pos + u.node.nodeSize <= restartPos) continue;
      if (u.kind === 'break') { forceNext = true; continue; }
      lastUnit = u;
      const r = cleanRect(u);
      if (forceNext) {
        forceNext = false;
        if (r.top + offset > pageStart(page) + 1) pushUnit(u);
        if (converged) break;
      }
      let lines = null;                   // linhas limpas (lidas uma vez)
      let guard = 0;
      while (!converged && r.bottom + offset > pageEnd(page) + 0.5 && guard++ < 100) {
        const top = r.top + offset;
        if (top >= pageEnd(page) - 0.5 && u.pos > restartPos) { pushWithKeep(i); continue; }
        if (u.kind === 'text') {
          if (!lines) lines = _kdCleanLines(view, u, paperTop, effTop(u.pos));
          const onPage = lines.filter(l => l.top + offset >= pageStart(page) - 2);
          let fit = 0;
          while (fit < onPage.length && onPage[fit].bottom + offset <= pageEnd(page) + 0.5) fit++;
          const continuing = onPage.length < lines.length;
          if (fit === onPage.length) break;
          const blockH = r.bottom - r.top;
          if (!continuing && (fit === 0 || (fit < 2 && lines.length >= 2))) {
            if (blockH <= usable) { pushWithKeep(i); continue; }      // órfã: desce inteiro
          }
          if (onPage.length - fit < 2 && fit >= 3) fit--;             // viúva: leva uma linha
          if (fit === 0) { pushWithKeep(i); continue; }
          const ln = onPage[fit];
          const tStart = u.pos + 1, tEnd = u.pos + u.node.nodeSize - 1;
          if (ln.pos == null || ln.pos <= tStart || ln.pos > tEnd) { if (blockH <= usable && !continuing) { pushWithKeep(i); continue; } break; }
          const height = Math.round(pageStart(page + 1) - (ln.top + offset));
          page++;
          offset += height;
          addPush({ kind: 'gap', pos: ln.pos, height, effect: height, page });
          continue;
        }
        if (r.bottom - r.top <= usable && u.pos > restartPos) { pushWithKeep(i); continue; }
        page = Math.max(page, Math.floor((r.bottom + offset) / (H + G)));
        break;
      }
    }

    pushes.sort((a_, b_) => a_.pos - b_.pos);
    let pages = (pushes.length ? pushes[pushes.length - 1].page : 0) + 1;
    if (converged) pages = Math.max(pages, st.pages || 1);
    else if (lastUnit) { const r = cleanRect(lastUnit); pages = Math.max(pages, Math.floor((r.bottom + offset + padB - 1) / (H + G)) + 1); }
    this.commit(pushes, pages);

    /* Conferência dos empurrões novos (em geral 1 ou 2): cada um tem que
       levar o conteúdo exatamente ao topo útil da folha. Se algum desviou,
       repagina a partir dele no mesmo tick — ele sai e é remedido. */
    const fresh = pushes.filter(p => !old.includes(p));
    if (fresh.length && (this.retries || 0) < 2) {
      const pt2 = paper.getBoundingClientRect().top;
      const gapEls = fresh.some(p => p.kind === 'gap') ? [...view.dom.querySelectorAll('.kd-page-gap')] : [];
      const bad = fresh.find(p => {
        const want = pageStart(p.page);
        if (p.kind === 'margin') {
          const el = view.nodeDOM(p.pos);
          return el && el.nodeType === 1 && Math.abs(el.getBoundingClientRect().top - pt2 - want) > 1.5;
        }
        const g = gapEls.find(x => { try { return view.posAtDOM(x, 0) === p.pos; } catch { return false; } });
        return g && Math.abs(g.getBoundingClientRect().bottom - pt2 - want) > 1.5;
      });
      if (bad) {
        this.retries = (this.retries || 0) + 1;
        this.forceUntrusted = bad.pos;
        this.schedule(bad.pos, bad.pos);
        return;
      }
    }
    this.retries = 0;
    storage.onLayout && storage.onLayout({ pages, enabled: true, pageHeight: H, pageGap: G });
  }
}

const KdPages = Extension.create({
  name: 'kdPages',
  addStorage() {
    return {
      enabled: false,
      pageHeight: 297 * 96 / 25.4,
      pageGap: 34,
      onLayout: null,
      _pager: null
    };
  },
  addCommands() {
    return {
      /* Liga/desliga o formato "Páginas" (desligado = bloco contínuo) */
      setPagesEnabled: (on) => () => {
        this.storage.enabled = !!on;
        this.storage._pager && this.storage._pager.schedule(0);
        return true;
      },
      repaginate: () => () => { this.storage._pager && this.storage._pager.schedule(0); return true; }
    };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [new Plugin({
      key: kdPagesKey,
      state: {
        init: () => ({ decos: DecorationSet.empty, pushes: [], pages: 1 }),
        apply(tr, st) {
          const meta = tr.getMeta(kdPagesKey);
          if (meta) return meta;
          if (!tr.docChanged) return st;
          // A lista de empurrões sai das próprias decorações mapeadas: se o
          // trecho foi apagado, a decoração some e o empurrão também.
          const decos = st.decos.map(tr.mapping, tr.doc);
          const pushes = decos.find().map(d => ({ ...d.spec.kdPush, pos: d.from })).sort((a, b) => a.pos - b.pos);
          return { decos, pushes, pages: st.pages };
        }
      },
      view: (view) => new KdPager(view, storage),
      props: {
        decorations(state) { return kdPagesKey.getState(state).decos; },
        /* ↑/↓ na linha colada a um vão de página: pula direto pra linha do
           outro lado (sem o cursor parar no espaço entre as folhas). */
        handleKeyDown(view, event) {
          if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
          const sel = view.state.selection;
          if (!sel.empty) return false;
          const gaps = kdPagesKey.getState(view.state).pushes.filter(p => p.kind === 'gap').map(p => p.pos);
          if (!gaps.length) return false;
          let here;
          try { here = view.coordsAtPos(sel.head); } catch { return false; }
          for (const g of gaps) {
            let before, after;
            try { before = view.coordsAtPos(Math.max(0, g - 1), -1); after = view.coordsAtPos(g, 1); } catch { continue; }
            const down = event.key === 'ArrowDown' && sel.head <= g && Math.abs(here.top - before.top) < 4;
            const up = event.key === 'ArrowUp' && sel.head >= g && Math.abs(here.top - after.top) < 4;
            if (!down && !up) continue;
            const target = view.posAtCoords({ left: here.left, top: (down ? after.top : before.top) + 2 });
            if (!target) return false;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target.pos)).scrollIntoView());
            return true;
          }
          return false;
        }
      }
    })];
  }
});

/* Editor somente-leitura — usado no viewer público. Sem colab (não conecta
   ao WS), sem autosave, sem toolbar. Só renderiza o PM JSON e permite scroll
   + seleção de texto pra o visitante copiar. */
function createReadOnlyEditor(mount, opts = {}) {
  return {
    editor: createKastorEditor(mount, {
      content: opts.initialJSON || null,
      editable: false,
      autofocus: false,
      placeholder: 'Documento vazio',
      onUpdate: () => {},
      onSelectionUpdate: () => {}
    })
  };
}

window.KastorWriter = {
  createEditor: createKastorEditor,
  createCollabEditor,
  createReadOnlyEditor,
  toHTML: editorToHTML,
  toText: editorToText,
  emptyDoc,
  NodeSelection,
  TextSelection,
  /* HTML (modelo, importação) → conteúdo do editor, pelo mesmo schema */
  htmlToJSON: (html) => generateJSON(String(html || ''), kdExtensions({ schemaOnly: true })),
  /* HTML do trecho selecionado (descrição da demanda criada a partir dele) */
  selectionHTML: (editor) => {
    const { from, to, $from } = editor.state.selection;
    const slice = editor.state.doc.slice(from, to);
    // Seleção dentro de uma lista vem só com os itens: devolve a lista inteira
    let frag = slice.content;
    const shared = $from.node($from.sharedDepth(to));
    if (['bulletList', 'orderedList', 'taskList'].includes(shared.type.name)) {
      try { frag = Fragment.from(shared.type.create(shared.attrs, frag)); } catch {}
    }
    const div = document.createElement('div');
    div.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(frag));
    return div.innerHTML;
  },
  version: '0.3.0'
};
