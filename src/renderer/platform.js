// Abstração da plataforma: Electron (window.cena, via preload) ou navegador (HTTP local).

function webPlatform() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) { sessionStorage.setItem('cenaToken', fromHash); history.replaceState(null, '', location.pathname); }
  const token = fromHash || sessionStorage.getItem('cenaToken') || '';
  return {
    mode: 'web',
    async call(name, args = {}, onEvent, id) {
      const res = await fetch(`/api/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cena-token': token },
        body: JSON.stringify({ args, id }),
      });
      if (!res.ok) throw new Error(res.status === 403 ? 'Sessão inválida: abra o endereço exibido no terminal.' : `Erro ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let final = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.event !== undefined) onEvent?.(msg.event);
          else final = msg;
        }
      }
      if (!final) throw new Error('Conexão interrompida.');
      if (!final.ok) { const e = new Error(final.error); e.code = final.code; throw e; }
      return final.result;
    },
    onOpenFile() {},
    onBeforeClose(fn) { addEventListener('beforeunload', () => { fn(); }); },
  };
}

export const platform = window.cena || webPlatform();
export const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const call = (name, args, onEvent, id) => platform.call(name, args, onEvent, id);

/** Salva bytes: diálogo nativo no desktop, download no navegador. */
export async function saveBytes(name, base64, ext, mime) {
  if (platform.mode === 'desktop') return call('dialog.saveBytes', { name, base64, ext });
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { path: name };
}

export function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Escolhe um arquivo local no navegador. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = async () => { const f = input.files[0]; resolve(f ? { name: f.name, text: await f.text() } : null); };
    input.click();
  });
}
