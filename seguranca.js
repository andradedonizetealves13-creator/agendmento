
 // seguranca.js — módulo compartilhado (index.html, painel.html, cliente.html)
 // Uso: import { hashSenha, verificarSenha, validarNovaSenha, semSenha } from './seguranca.js';
 //
 // IMPORTANTE:
 // Este módulo não configura TLS/HTTPS nem substitui a segurança do backend.

const ITERACOES = 600000;
const TAMANHO_SALT = 16;
const TAMANHO_HASH_BITS = 256;
const TAMANHO_HASH_BYTES = TAMANHO_HASH_BITS / 8;
const PREFIXO_HASH = 'pbkdf2';
const ITERACOES_MINIMAS = 100000;
const ITERACOES_MAXIMAS = 1000000;
const enc = new TextEncoder();

function exigirContextoSeguro() {
    if (
        typeof globalThis.isSecureContext === 'boolean' &&
        !globalThis.isSecureContext
    ) {
        throw new Error(
            'Acesse a aplicação por HTTPS válido ou localhost.'
        );
    }

    if (!globalThis.crypto?.subtle ||
        !globalThis.crypto?.getRandomValues) {
        throw new Error(
            'Web Crypto API indisponível. Verifique o HTTPS e o navegador.'
        );
    }
}

function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let binario = '';

    for (const byte of bytes) {
        binario += String.fromCharCode(byte);
    }

    return btoa(binario);
}

function fromB64(valor) {
    if (
        typeof valor !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(valor)
    ) {
        throw new Error('Base64 inválido.');
    }

    const binario = atob(valor);

    return Uint8Array.from(
        binario,
        caractere => caractere.charCodeAt(0)
    );
}

async function derivar(senha, salt, iteracoes) {
    exigirContextoSeguro();

    if (typeof senha !== 'string') {
        throw new TypeError('A senha deve ser uma string.');
    }

    if (!(salt instanceof Uint8Array) ||
        salt.length !== TAMANHO_SALT) {
        throw new Error('Salt inválido.');
    }

    if (
        !Number.isSafeInteger(iteracoes) ||
        iteracoes < ITERACOES_MINIMAS ||
        iteracoes > ITERACOES_MAXIMAS
    ) {
        throw new Error('Número de iterações inválido.');
    }

    const chave = await crypto.subtle.importKey(
        'raw',
        enc.encode(senha),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );

    return crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt,
            iterations: iteracoes,
            hash: 'SHA-256'
        },
        chave,
        TAMANHO_HASH_BITS
    );
}

export const ehHash = valor =>
    typeof valor === 'string' &&
    valor.startsWith(`${PREFIXO_HASH}$`);

export async function hashSenha(senha) {
    exigirContextoSeguro();

    if (typeof senha !== 'string' || senha.length === 0) {
        throw new TypeError('Informe uma senha válida.');
    }

    const salt = crypto.getRandomValues(
        new Uint8Array(TAMANHO_SALT)
    );

    const bits = await derivar(senha, salt, ITERACOES);

    return `${PREFIXO_HASH}$${ITERACOES}$${toB64(salt)}$${toB64(bits)}`;
}

function compararBytes(a, b) {
    if (
        !(a instanceof Uint8Array) ||
        !(b instanceof Uint8Array) ||
        a.length !== b.length
    ) {
        return false;
    }

    let diferenca = 0;

    for (let i = 0; i < a.length; i++) {
        diferenca |= a[i] ^ b[i];
    }

    return diferenca === 0;
}

function interpretarHash(guardado) {
    const partes = guardado.split('$');

    if (partes.length !== 4 || partes[0] !== PREFIXO_HASH) {
        throw new Error('Formato de hash inválido.');
    }

    const iteracoes = Number(partes[1]);

    if (
        !Number.isSafeInteger(iteracoes) ||
        iteracoes < ITERACOES_MINIMAS ||
        iteracoes > ITERACOES_MAXIMAS
    ) {
        throw new Error('Número de iterações inválido.');
    }

    const salt = fromB64(partes[2]);
    const hash = fromB64(partes[3]);

    if (
        salt.length !== TAMANHO_SALT ||
        hash.length !== TAMANHO_HASH_BYTES
    ) {
        throw new Error('Tamanho de hash ou salt inválido.');
    }

    return { iteracoes, salt, hash };
}

// Retorna { ok, precisaMigrar }.
// Senhas antigas em texto puro são aceitas apenas para migração.
// Migre o registro no backend após autenticação válida.
export async function verificarSenha(senha, guardado) {
    exigirContextoSeguro();

    if (
        typeof senha !== 'string' ||
        typeof guardado !== 'string' ||
        guardado.length === 0
    ) {
        return { ok: false, precisaMigrar: false };
    }

    if (!ehHash(guardado)) {
        const ok = senha === guardado;

        return {
            ok,
            precisaMigrar: ok
        };
    }

    try {
        const { iteracoes, salt, hash } =
            interpretarHash(guardado);

        const calculado = new Uint8Array(
            await derivar(senha, salt, iteracoes)
        );

        return {
            ok: compararBytes(calculado, hash),
            precisaMigrar: iteracoes < ITERACOES
        };
    } catch {
        return {
            ok: false,
            precisaMigrar: false
        };
    }
}

// Retorna a mensagem de erro ou null se estiver válido.
export function validarNovaSenha(nova, confirmacao) {
    if (typeof nova !== 'string' || nova.length < 12) {
        return 'A senha deve ter pelo menos 12 caracteres.';
    }

    if (nova.length > 1024) {
        return 'A senha excede o tamanho máximo permitido.';
    }

    if (!/[A-Za-zÀ-ÿ]/.test(nova) || !/\d/.test(nova)) {
        return 'A senha deve conter letras e números.';
    }

    if (nova !== confirmacao) {
        return 'A confirmação não é igual à nova senha.';
    }

    return null;
}

// Remove campos de senha e hash antes de exibir objetos.
// A API também deve retornar somente os campos necessários.
export function semSenha(obj) {
    if (
        !obj ||
        typeof obj !== 'object' ||
        Array.isArray(obj)
    ) {
        return {};
    }

    const {
        password,
        senha,
        senha_hash,
        password_hash,
        passwordHash,
        senhaHash,
        hash_senha,
        ...resto
    } = obj;

    return resto;
}
