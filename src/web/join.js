// Página de invitación: el token viaja en el fragmento (#) y nunca llega al servidor al abrirla; aquí solo se
// arma el comando del instalador, que es quien lo canjea.
'use strict';
const token = (/^#(aii_[\w-]+)$/.exec(location.hash) || [])[1];
const cmd = document.getElementById('cmd');
if (!token) {
  document.getElementById('err').textContent = 'Este enlace no trae una invitación válida. Pide otro al operador.';
} else {
  cmd.textContent = `node scripts/install.mjs --client claude --join "${location.origin}/join#${token}"`;
}
document.getElementById('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cmd.textContent);
    document.getElementById('copied').textContent = 'copiado';
  } catch {
    document.getElementById('copied').textContent = 'selecciona y copia a mano';
  }
});
