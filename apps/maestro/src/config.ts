import { Config } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

export const HOSTNAME = "127.0.0.1"

// 7351 é do Grafana (jarvis-telemetria) e 7352 do coletor.
export const DEFAULT_PORT = 7353

const home = homedir()

/** Pasta padrão da memória do maestro; `JARVIS_MAESTRO_DIR` troca (o teste usa uma pasta própria). */
export const DEFAULT_DIR = join(home, ".local", "share", "jarvis", "maestro")

/**
 * Tudo que a fila e o vigia leem do ambiente. Os padrões são os do maestro real;
 * um maestro de teste troca nome, pasta, workspace e porta.
 */
export const MaestroConfig = Config.all({
  name: Config.String("JARVIS_MAESTRO_NOME").pipe(Config.withDefault("maestro")),
  dir: Config.String("JARVIS_MAESTRO_DIR").pipe(Config.withDefault(DEFAULT_DIR)),
  workspace: Config.String("JARVIS_MAESTRO_WORKSPACE").pipe(Config.withDefault("maestro")),
  herdr: Config.String("JARVIS_HERDR").pipe(Config.withDefault(join(home, ".local", "bin", "herdr"))),
  fala: Config.String("JARVIS_FALA").pipe(Config.withDefault(join(home, ".local", "bin", "jarvis-fala"))),
  port: Config.Port("JARVIS_EVENTOS_PORT").pipe(Config.withDefault(DEFAULT_PORT)),
  // Arquivo de settings extra passado ao claude com --settings (o teste injeta os hooks assim).
  settings: Config.String("JARVIS_MAESTRO_SETTINGS").pipe(Config.withDefault(""))
})

export type MaestroConfig = Config.Success<typeof MaestroConfig>

/** Caminhos derivados da pasta do maestro. */
export const paths = (dir: string) => ({
  dir,
  casa: join(dir, "casa"),
  estado: join(dir, "estado.md"),
  sessao: join(dir, "sessao.json"),
  pane: join(dir, "pane.json"),
  sistema: join(dir, "sistema.md"),
  fila: join(dir, "fila.json"),
  rotinas: join(dir, "rotinas.json"),
  rotinasEstado: join(dir, "rotinas-estado.json"),
  token: join(dir, "eventos-token"),
  agentes: join(dir, "agentes.json"),
  /** Pasta própria de cada especialista: casa, sessão, pane e estado. */
  especialista: (nome: string) => join(dir, "agentes", nome)
})
