// seguranca.js — módulo compartilhado (index.html, painel.html, cliente.html)
// Uso: import { hashSenha, verificarSenha, validarNovaSenha, semSenha } from './seguranca.js';

const ITERACOES = 150000;
const enc = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derivar(senha, salt, iter) {
    const chave = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
    return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, chave, 256);
}

export const ehHash = (s) => typeof s === 'string' && s.startsWith('pbkdf2$');

// Gera "pbkdf2$iteracoes$salt$hash" (salt aleatório por senha)
export async function hashSenha(senha) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const bits = await derivar(senha, salt, ITERACOES);
    return `pbkdf2$${ITERACOES}$${toB64(salt)}$${toB64(bits)}`;
}

// Confere a senha. Aceita contas antigas (texto puro) e avisa para converter.
// Retorna { ok, precisaMigrar }. Se precisaMigrar for true, salve hashSenha(senha) no cadastro.
export async function verificarSenha(senha, guardado) {
    if (!guardado) return { ok: false, precisaMigrar: false };
    if (!ehHash(guardado)) {
        const ok = senha === guardado;
        return { ok, precisaMigrar: ok };
    }
    const [, iter, salt, hash] = guardado.split('$');
    const bits = await derivar(senha, fromB64(salt), parseInt(iter, 10));
    return { ok: toB64(bits) === hash, precisaMigrar: parseInt(iter, 10) < ITERACOES };
}

// Validação para QUALQUER criação/troca de senha. Retorna texto do erro ou null se estiver ok.
export function validarNovaSenha(nova, confirmacao) {
    if (!nova || nova.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
    if (!/[A-Za-z]/.test(nova) || !/\d/.test(nova)) return 'A senha deve ter letras e números.';
    if (nova !== confirmacao) return 'A confirmação não é igual à nova senha.';
    return null;
}

// Remove a senha de um objeto antes de exibir/listar (ex.: gestão de clientes)
export function semSenha(obj) {
    const { password, ...resto } = obj || {};
    return resto;
}
