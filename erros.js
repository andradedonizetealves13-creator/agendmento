/* Primstav – captura de erros do navegador (só registra no console). */
window.addEventListener('error', function (e) { console.error('[Primstav] erro:', e.message, e.filename + ':' + e.lineno); });
window.addEventListener('unhandledrejection', function (e) { console.error('[Primstav] promessa rejeitada:', e.reason); });
