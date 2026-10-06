/*
 * Entrypoint do plugin do lado servidor.
 *
 * O ditado roda inteiramente na TUI (gravação, transcrição e envio), mas a
 * descoberta do componente TUI passa pelo servidor: a CLI pergunta ao server
 * quais plugins estão ativos e carrega o export `./tui` daqueles marcados com
 * `tui: true` (mesmo padrão do opencode-choose-directory). Sem essa flag, o
 * componente de TUI não é carregado.
 *
 * Este arquivo de propósito NÃO tem imports: plugins locais podem falhar na
 * carga se tentarem resolver pacotes/módulos na inicialização do servidor.
 */
export default {
  id: "opencode-voice",
  tui: true,
  async setup() {},
}
