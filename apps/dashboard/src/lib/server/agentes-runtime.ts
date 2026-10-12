import { Layer, ManagedRuntime } from 'effect';
import { HerdrCli } from './herdr-controle.js';
import { memoMap, TelemetryLive } from './telemetry.js';

/** O runtime do controle de agentes: o CLI do herdr e o exportador OTLP compartilhado do dashboard. */
export const agentesRuntime = ManagedRuntime.make(Layer.merge(HerdrCli.layerNode, TelemetryLive), { memoMap });

import.meta.hot?.dispose(() => agentesRuntime.dispose());
