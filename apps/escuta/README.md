# Escuta do Jarvis

App de barra de menus (sem Dock) que ouve sempre, transcreve em pt-BR no próprio Mac
(SpeechAnalyzer/SpeechTranscriber, on-device) e manda toda fala com palavras, inteira e numa mensagem só,
como `[voz do Fernando] ...` para o painel do orquestrador no herdr (`wT2:p2`; se o id mudar, o agente
chamado `maestro`). Não há palavra de ativação nem filtro de eco: se a frase começar com "Jarvis",
"camarada" ou algo parecido (Jardes, Jarbas...), só esse prefixo sai. Ruído sem palavras é descartado.
Toca um Tink ao enviar.

## Como decide que a fala acabou

- Silêncio medido no próprio áudio do microfone, em tempo real.
- Com 1,3 s de silêncio, pede ao reconhecedor os resultados finais (sem esperar ele decidir sozinho).
- Frase com cara de completa: envia. Frase terminada em conectivo ("e", "que", "pra", "mas",
  "porque"...) ou vírgula: espera até 2,5 s de silêncio. Texto ainda mudando: espera.
- Só envia texto final; nunca manda fragmento nem "(continuação)".
- Enquanto `~/.local/share/jarvis/fala.lock` está ocupado (o Jarvis falando), qualquer fala com palavras
  corta a fala na hora: encerra quem segura o lock (lockf, o script do Kokoro, afplay ou say), e o que foi
  dito segue inteiro para o orquestrador. "Para" ou "chega" soltos só calam o Jarvis.

## Instalar e operar

```sh
scripts/instalar.sh --carregar     # compila, monta ~/.local/share/jarvis/bin/Escuta.app e carrega o LaunchAgent
launchctl kickstart -k gui/$(id -u)/dev.jarvis.escuta   # reiniciar
launchctl bootout gui/$(id -u)/dev.jarvis.escuta        # desligar até o próximo login
```

O LaunchAgent `dev.jarvis.escuta` abre no login e reabre depois de falha (saída 75 = reinício pedido
pela própria escuta, por exemplo pelo botão Reiniciar). "Sair" no painel encerra de verdade (saída 0).
Clicar no ícone da barra de menus abre o painel com a onda do microfone, estado, pedidos e controles.
Se o coreaudiod reiniciar, o microfone sumir ou a captura der erro, o processo sai e o launchd abre de novo.
A captura é só de entrada (AVCaptureSession): não mexe na saída de áudio nem no dispositivo padrão.

Logs: `~/.local/share/jarvis/escuta/logs/escuta.log` (diagnóstico, com a latência de cada pedido)
e `escuta.events.jsonl` (eventos).

## Motor de reconhecimento (`ESCUTA_STT`)

- `apple` (padrão): SpeechAnalyzer/SpeechTranscriber da Apple, on-device.
- `parakeet`: NVIDIA Parakeet TDT v3 (multilíngue, pt e inglês na mesma frase) em Core ML no Neural Engine,
  pelo [FluidAudio](https://github.com/FluidInference/FluidAudio), com VAD Silero na frente. Só o trecho
  que a VAD marca como voz vai ao modelo: ruído não vira palavra. Enquanto a pessoa fala, o trecho é
  transcrito de novo a cada 256 ms (para interromper o Jarvis); com silêncio, sai o texto final.
  O silêncio que fecha a frase cai para 0,7 s (`ESCUTA_SILENCIO` ainda manda). Os modelos (~460 MB)
  ficam em `~/Library/Application Support/FluidAudio/Models` e baixam no primeiro uso.

```sh
ESCUTA_STT=parakeet scripts/instalar.sh --carregar   # liga o Parakeet
scripts/instalar.sh --carregar                       # volta para a Apple
.build/release/Escuta --stt parakeet --audio /tmp/f.aiff --saida /tmp/pedidos.jsonl
```

Ajustes no `EnvironmentVariables` do plist: `ESCUTA_SILENCIO` (1.3), `ESCUTA_SILENCIO_ABERTA` (2.5),
`ESCUTA_MIC` (partes do nome dos microfones em ordem de preferência, separadas por vírgula, padrão `HyperX,iPhone,MacBook`; troca na hora quando um aparelho entra ou sai, e nenhum presente cai no embutido), `ESCUTA_PANE`, `ESCUTA_ORQUESTRADOR`,
`ESCUTA_STT` (`apple` ou `parakeet`).

Reiniciar, Sair, `launchctl bootout` ou reinstalar não cortam frase: com alguém falando, a escuta espera a frase terminar e a envia antes de sair (até 20 s; o LaunchAgent tem `ExitTimeOut` 30).

O app é assinado com a identidade local "Jarvis Local Signing" (`JARVIS_SIGNING_IDENTITY`), então as permissões de microfone e fala sobrevivem a novas compilações; sem a identidade, cai em assinatura ad hoc e o macOS pode pedir de novo.

## Testar sem microfone

```sh
say -v Luciana -o /tmp/f.aiff "Jarvis, teste da escuta."
.build/release/Escuta --audio /tmp/f.aiff --saida /tmp/pedidos.jsonl
.build/release/Escuta --saida /tmp/pedidos.jsonl --sem-som --abrir-painel   # instância de teste com o painel aberto
swift test
```
