# Maestro

Orquestrador do Jarvis no herdr. O vigia (LaunchAgent `dev.jarvis.maestro`) mantém o maestro e os especialistas de pé.

## agentes.json

Os especialistas vêm de `~/.local/share/jarvis/maestro/agentes.json` (modelo em `agentes.example.json`). Cada item tem:

- `nome`: nome no herdr (`^[a-z][a-z0-9_-]{0,31}$`).
- `papel`: uma linha com a função.
- `prompt`: instruções próprias do especialista.
- `model` (opcional): modelo do claude daquele especialista, passado como `--model` na criação e no `--resume` (ex.: `"sonnet"`, `"opus"`, `"haiku"`). Sem o campo, vale o padrão do claude.

Todo especialista recebe no prompt de sistema a regra de escolha de modelo dos subagentes (haiku, sonnet, opus), definida em `agente/especialista-sistema.md.in` e `agente/especialista-CLAUDE.md.in`.
