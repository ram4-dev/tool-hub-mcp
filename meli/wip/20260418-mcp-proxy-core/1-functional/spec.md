# Functional Specification — toolhub (MVP v0.1)

**Feature ID**: feat-20260418-mcp-proxy-core
**Status**: draft
**Created**: 2026-04-18
**Language**: es

---

## 1. Problem Statement

Los coding agents (Claude Code, Cursor, Codex) cargan al contexto el schema completo de cada MCP server configurado **antes de tipear el primer prompt**. Un usuario con 5-10 MCPs puede consumir 40-60k tokens en metadata sin haber hecho nada todavía. Además, no existe visibilidad sobre:

- Qué MCPs se usan realmente y cuáles son "zombies" activos-pero-nunca-invocados.
- Cuánta latencia y costo agrega cada tool.
- Qué tools son redundantes entre MCPs.

Los gestores existentes (CCHub, claude-code-tool-manager) son inventarios estáticos: muestran qué hay instalado, pero no cómo se usa ni cuánto cuesta tenerlo.

---

## 2. Objective

Construir **toolhub**, un proxy MCP local single-binary que:

1. Reduce el consumo inicial de contexto del agente vía lazy-loading de schemas.
2. Expone un **catálogo unificado compacto** de todas las tools disponibles.
3. Registra telemetría **por invocación** (tool, timestamp, latencia, éxito) en SQLite local.
4. Provee un CLI para consultar estado, uso y habilitar/deshabilitar MCPs o tools.

**No-goal v0.1**: skills, plugins, hooks, multi-cliente, UI web, registry federado, embeddings semánticos.

---

## 3. Success Metrics

| Métrica | Target v0.1 |
|---|---|
| Instalaciones | ≥ 50 |
| Usuarios con data de ahorro | ≥ 10 reportando resultados semanales |
| Reducción de tokens iniciales | ≥ 60% vs. setup directo |
| Overhead de latencia por invocación | ≤ 50 ms p95 |
| Pérdida de funcionalidad vs. directo | 0 reportes |

---

## 4. Users & Use Cases

### 4.1 Usuario primario
Desarrollador que usa Claude Code con 3+ MCPs configurados y nota el costo de contexto / quiere saber qué usa realmente.

### 4.2 Flujo principal

1. Usuario instala toolhub: `npx toolhub init` o `npm install -g toolhub`.
2. Usuario edita `~/.claude.json` una vez para apuntar a toolhub como único MCP (migración asistida por el CLI: `toolhub migrate --dry-run` + `toolhub migrate --apply` genera un diff del `.claude.json` con backup).
3. Usuario arranca Claude Code normalmente. El agente ve un solo MCP (toolhub) que expone un catálogo compacto.
4. Cuando el agente quiere usar una tool, pide su schema completo; toolhub rutea la invocación al MCP hijo real.
5. Usuario corre `toolhub stats` cuando quiera ver tokens ahorrados, tools más usadas, MCPs zombies.

---

## 5. User Stories

### US-1: Instalación y onboarding
**Como** usuario de Claude Code
**Quiero** instalar toolhub con un solo comando
**Para** que lea mi config existente sin que yo toque nada manualmente.

**Acceptance criteria**:
- `npx toolhub init` lee `~/.claude.json` y `~/.claude/plugins/**/.mcp.json`.
- Muestra un resumen: N MCPs detectados, estimación de tokens actuales.
- Genera un snippet listo para pegar en `~/.claude.json` (no escribe el archivo).
- Si el usuario ya tiene toolhub configurado, detecta y muestra estado.

### US-2: Proxy transparente
**Como** agente conectado a toolhub
**Quiero** ver un catálogo compacto y pedir schemas on-demand
**Para** no cargar todo al contexto al arrancar.

**Acceptance criteria**:
- Toolhub expone 3 tools: `list_capabilities`, `get_schema`, `invoke`.
- `list_capabilities` devuelve `[{name, short_description}]` para todas las tools de todos los MCPs hijos.
- `get_schema(name)` devuelve el JSON schema completo de esa tool.
- `invoke(name, args)` rutea al MCP hijo correspondiente y devuelve el resultado tal cual.
- Nombres de tools se namespacian como `mcp_name.tool_name` para evitar colisiones.

### US-3: Telemetría de uso
**Como** usuario
**Quiero** que toolhub guarde un registro por invocación
**Para** saber qué uso de verdad.

**Acceptance criteria**:
- Cada invocación guarda en SQLite: `{tool_name, mcp_name, timestamp, latency_ms, success, error_type?, tokens_saved_estimate}`.
- **No se guardan payloads** (ni args ni result) — solo metadata.
- La tabla soporta queries eficientes por fecha, tool, MCP.

### US-4: Visibilidad con CLI
**Como** usuario
**Quiero** un CLI que resuma mi uso
**Para** decidir qué MCPs mantener.

**Acceptance criteria**:
- `toolhub status`: estado del proxy (running, PID, MCPs hijos activos, warnings).
- `toolhub stats`: resumen de la última semana — top tools, top MCPs, tokens ahorrados (estimado), latencias.
- `toolhub unused [--since 7d]`: lista tools que nunca se invocaron en el período.
- `toolhub enable <tool>` / `toolhub disable <tool>`: oculta/muestra una tool específica del catálogo.

### US-5: Resiliencia de MCPs hijos
**Como** usuario
**Quiero** que si un MCP hijo crashea, toolhub siga funcionando
**Para** no perder los otros MCPs.

**Acceptance criteria**:
- Si un MCP hijo muere, toolhub lo excluye temporalmente del catálogo y loguea el incidente.
- Auto-restart con backoff exponencial (3 intentos, 1s/5s/30s).
- El resto de los MCPs siguen disponibles para el agente durante el crash.

### US-6: Fallback y salida
**Como** usuario
**Quiero** poder volver a la config directa si toolhub me rompe algo
**Para** no quedar atado.

**Acceptance criteria**:
- `toolhub migrate --revert` restaura el `.claude.json` al estado previo desde backup.
- El backup se crea automáticamente en el `migrate --apply` (archivo `.claude.json.toolhub-backup-<timestamp>`).

### US-7: Catálogo grande (fallback)
**Como** usuario con muchos MCPs
**Quiero** que toolhub me avise si mi catálogo supera el umbral de 5k tokens
**Para** entender por qué v0.1 no optimiza bien mi caso.

**Acceptance criteria**:
- Si `total_tools × avg_desc_tokens > 5k`, toolhub muestra warning al arrancar y en `toolhub status`.
- El warning sugiere esperar v0.2 (modo búsqueda con BM25) o desactivar MCPs pesados.
- La funcionalidad sigue operando igual (sin degradación).

---

## 6. Scope

### In Scope (v0.1)
- Proxy MCP contra **Claude Code** exclusivamente.
- Lectura de `~/.claude.json` y plugins de Claude Code.
- Ruteo transparente de invocaciones.
- Telemetría metadata-only en SQLite.
- CLI: `init`, `migrate`, `status`, `stats`, `unused`, `enable`, `disable`.
- Modo catálogo directo (no búsqueda).
- Auto-restart de MCPs hijos con backoff.
- Licencia MIT.

### Out of Scope (v0.1)
- Skills, plugins nativos de Claude Code, hooks, subagents.
- Cursor, Codex, Continue.
- UI web o desktop.
- Embeddings semánticos / vector search.
- BM25 / FTS5 search mode (v0.2).
- Perfiles por proyecto (v0.2).
- Logueo de payloads.
- Registry federado.
- Auditoría de seguridad de MCPs.
- Modificación automática de `~/.claude.json` sin consentimiento explícito.

---

## 7. Dependencies

| Dep | Tipo | Notas |
|---|---|---|
| Claude Code CLI | Runtime externo | Cliente del proxy |
| MCPs hijos | Runtime externo | Son instalados por el usuario |
| Node.js ≥ 20 | Runtime | Requerido por `@modelcontextprotocol/sdk` |
| SQLite | Embebido | Via `better-sqlite3` (native binding) |

---

## 8. Risks

| Riesgo | Mitigación |
|---|---|
| El modelo "recuerda" tools filtradas y las invoca por nombre | Testear sesiones largas desde día 1 |
| MCP hijo crashea y arrastra a toolhub | Supervisor con auto-restart |
| Overhead hace peor UX que config directa | Budget ≤50ms p95, medir desde prototipo |
| Formato `.claude.json` cambia | Tests snapshot + adapter pattern |
| Estimación de "tokens ahorrados" es inexacta | Usar tokenizador real (tiktoken-style) y documentar metodología |

---

## 9. Edge Cases

1. **MCP con mismo nombre de tool**: namespace forzado (`github.create_pr` vs `gitlab.create_pr`).
2. **MCP con schema inválido al arrancar**: excluir del catálogo, warning en `status`.
3. **Invocación de tool deshabilitada** (`toolhub disable`): retorna error MCP claro.
4. **Invocación de tool que dejó de existir** (MCP hijo actualizó): error MCP + actualizar catálogo.
5. **SQLite lock en escritura concurrente**: WAL mode + retry corto.
6. **Proxy corriendo ya** (doble init): detectar lockfile y error amigable.
7. **Timeout de MCP hijo**: default 30s, configurable por tool en SQLite.

---

## 10. Acceptance Summary

La v0.1 se considera lista cuando:
- Un usuario con 5 MCPs puede correr `npx toolhub init`, seguir instrucciones, y tener Claude Code funcionando vía proxy en <5 minutos.
- El consumo inicial de contexto cae ≥60% medido con tokenizer real.
- `toolhub stats` después de una semana de uso muestra datos útiles.
- Si un MCP hijo muere, el agente no ve el proxy caído — solo esa tool en particular.
- `toolhub migrate --revert` restaura el estado original sin pérdida.
