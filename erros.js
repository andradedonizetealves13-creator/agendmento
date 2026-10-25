// Traduz erros do Firebase (login e banco de dados) para mensagens claras em português.
// Uso: window.traduzErroAuth(err, 'login' | 'cadastro' | 'google')
(function () {
    var M = {
        'auth/invalid-credential': 'E-mail ou senha incorretos. Confira os dados e tente novamente.',
        'auth/wrong-password': 'Senha incorreta. Tente novamente ou clique em "Esqueci minha senha".',
        'auth/user-not-found': 'Não encontramos uma conta com este e-mail.',
        'auth/invalid-email': 'O e-mail digitado não é válido. Exemplo: nome@gmail.com.',
        'auth/missing-password': 'Digite a sua senha.',
        'auth/missing-email': 'Digite o seu e-mail.',
        'auth/user-disabled': 'Esta conta foi desativada. Entre em contato com o suporte.',
        'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos ou redefina a senha em "Esqueci minha senha".',
        'auth/email-already-in-use': 'Já existe uma conta com este e-mail. Use a aba "Entrar" ou "Esqueci minha senha".',
        'auth/weak-password': 'A senha é muito fraca. Use pelo menos 6 caracteres.',
        'auth/network-request-failed': 'Sem conexão com a internet. Verifique sua rede e tente de novo.',
        'auth/popup-closed-by-user': 'A janela do Google foi fechada antes de concluir o login.',
        'auth/cancelled-popup-request': 'A janela do Google foi fechada antes de concluir o login.',
        'auth/popup-blocked': 'O navegador bloqueou a janela do Google. Libere os pop-ups e tente de novo.',
        'auth/account-exists-with-different-credential': 'Este e-mail já está cadastrado com outro método de login. Entre com e-mail e senha.',
        'auth/credential-already-in-use': 'Esta conta já está vinculada a outro cadastro.',
        'auth/requires-recent-login': 'Por segurança, entre novamente para continuar.',
        'auth/operation-not-allowed': 'Este método de login não está ativado. Fale com o suporte.'
    };
    window.traduzErroAuth = function (err, contexto) {
        var code = (err && err.code) || '';
        var msg = (err && err.message) || '';
        if (M[code]) return M[code];
        if (/permission[_ -]?denied/i.test(code + ' ' + msg)) {
            return contexto === 'cadastro'
                ? 'Não foi possível salvar os dados do cadastro (permissão negada). Tente novamente ou fale com o suporte.'
                : 'Sem permissão para acessar os dados. Tente entrar novamente.';
        }
        if (/network|offline/i.test(code + ' ' + msg)) return M['auth/network-request-failed'];
        if (!msg || /^Firebase:/i.test(msg)) return 'Não foi possível concluir. Tente novamente em instantes.';
        return msg;
    };
})();
