# Plan — Asistente de preguntas con n8n (bot de documentación)

> Documento de planificación. **Nada implementado.** Diseño para un asistente
> que responde dudas sobre el uso de DISMAP a partir de la documentación, sin
> que esa documentación esté visible dentro del sistema. Pensado para que un
> admin nuevo, un operador, o el super admin resuelvan cualquier duda de uso
> preguntando en lenguaje natural.

## Qué resuelve

Hoy la documentación está en `/docs/` (páginas navegables, solo admin). El
requerimiento nuevo:

- La documentación **no debe estar visible** como páginas dentro del sistema.
- En su lugar, un **asistente de chat** responde preguntas sobre cómo usar la app.
- Lo tienen **todos los roles** (super admin, admin, operador), pero cada uno
  recibe respuestas acordes a lo que puede hacer.
- Un usuario nuevo (p. ej. un admin recién creado) aprende preguntando, sin leer
  un manual completo.

La solución es un **bot RAG** (Retrieval-Augmented Generation): un modelo de IA
responde usando **solo** el contenido de la documentación como fuente, orquestado
por **n8n**. El conocimiento vive en n8n, no en páginas servidas por DISMAP.

## Arquitectura

```
  Usuario (en DISMAP, ya autenticado)
        │  pregunta: "¿cómo creo una geocerca?"
        ▼
  Widget de chat en el panel  ──HTTPS──▶  Backend DISMAP (proxy)
        ▲                                   │  valida sesión + rol
        │  respuesta                        ▼
        └──────────────────────────  n8n Webhook (workflow del bot)
                                            │  arma el prompt con la doc
                                            ▼
                                      Modelo de IA (Claude)
                                            │
                                      responde citando la doc
```

Clave del diseño: **el navegador nunca habla directo con n8n.** DISMAP hace de
**proxy**: recibe la pregunta del widget (con el token de sesión que ya usa la
API), verifica el rol, y reenvía a n8n con un secreto que solo vive en el
servidor. Así la URL del webhook y su clave nunca quedan expuestas en el
frontend, y el acceso queda atado al login existente.

## Dos enfoques (empezar por el simple)

La documentación de DISMAP es **pequeña** (3 documentos: uso, instalación,
técnico). Eso cambia la decisión técnica:

### Enfoque A — Contexto completo *(recomendado para empezar)*
Como la doc entera cabe de sobra en la ventana de contexto del modelo, **no hace
falta base de datos vectorial ni embeddings**. En cada pregunta se le pasa al
modelo **toda la documentación** como contexto del sistema y responde. Con caché
de prompt, ese contexto fijo se cobra una sola vez y las siguientes preguntas son
baratas.
- **Ventajas:** simple de montar (1 nodo de IA en n8n), sin infraestructura
  extra, respuestas muy precisas (el modelo ve todo).
- **Cuándo deja de servir:** cuando la doc crezca a decenas de páginas.

### Enfoque B — RAG con base vectorial *(para cuando la doc crezca)*
Se parte la doc en fragmentos, se generan *embeddings* y se guardan en una base
vectorial. En cada pregunta se recuperan solo los fragmentos relevantes y se le
pasan al modelo.
- **Base vectorial recomendada: PostgreSQL con `pgvector`** — DISMAP **ya corre
  PostgreSQL**, así que se añade la extensión `pgvector` y no se monta otra base.
  n8n tiene nodo nativo "Postgres PGVector Store".
- **Ventajas:** escala a documentación grande; menor costo por pregunta.
- **Costo:** más piezas que mantener (embeddings, reindexado al cambiar la doc).

> **Recomendación:** arrancar con **A**. Es el 90% del valor con el 10% del
> esfuerzo, y como la doc es corta, es igual de preciso. Migrar a **B** solo si la
> documentación crece mucho.

## El workflow en n8n (enfoque A)

Nodos, en orden:

1. **Webhook** (trigger) — recibe `POST` con `{ pregunta, rol, historial? }`.
   Protegido con autenticación de header (un secreto que envía el backend DISMAP).
2. **(Opcional) Edit Fields** — arma el mensaje de sistema: la documentación
   completa + reglas de comportamiento (ver "El prompt" abajo) + el rol del
   usuario.
3. **AI Agent / Basic LLM Chain** — nodo de IA de n8n con el modelo de Claude.
   - Sistema: la doc + reglas + rol.
   - Usuario: la pregunta (y opcionalmente el historial de la conversación).
4. **Respond to Webhook** — devuelve `{ respuesta }` al backend DISMAP.

**Modelo recomendado:** Claude. Para un bot de documentación, prioriza costo y
velocidad:
- **`claude-haiku-4-5`** — el más económico y rápido ($1 / $5 por millón de
  tokens de entrada/salida). Ideal para un asistente de preguntas frecuentes.
- **`claude-sonnet-5`** — si se quiere más calidad de redacción/razonamiento
  ($3 / $15). Buen punto medio.
- Con **caché de prompt** (la doc va fija al inicio), el costo real por pregunta
  baja mucho porque el bloque de documentación se cobra a ~0.1× tras la primera.

### Ingesta de la documentación (enfoque B, si se adopta)
Workflow aparte, se corre al cambiar la doc:
1. Cargar los documentos (los `.md`/`.html` de `docs/`, o un texto maestro).
2. **Text Splitter** — partir en fragmentos (~500–1000 tokens con solape).
3. **Embeddings** (nodo de embeddings) → **Postgres PGVector Store** (insertar).
Re-ejecutar cuando la documentación cambie.

## El prompt del asistente (reglas)

El mensaje de sistema define el comportamiento. Puntos que debe incluir:

- **Fuente única:** "Responde ÚNICAMENTE con base en la documentación de DISMAP
  que se te entrega. Si la respuesta no está en la documentación, dilo con
  claridad y sugiere consultar al administrador — no inventes."
- **Rol del usuario:** "El usuario tiene el rol `{rol}`. Si pregunta por algo
  que su rol no permite (p. ej. un operador preguntando cómo registrar
  dispositivos), explícale que esa acción es solo de administradores y dile qué
  sí puede hacer."
- **Tono:** claro, breve, orientado a la acción; pasos numerados cuando aplique.
- **Alcance:** "Responde solo sobre el uso y la gestión de DISMAP. Si preguntan
  algo ajeno, redirige amablemente."

Esto responde directo a lo pedido: el operador pregunta sobre gestión y recibe
respuesta oportuna dentro de su alcance; el admin nuevo aclara cualquier duda de
uso.

## Integración con DISMAP (lo que se añade a la app)

1. **Backend — endpoint proxy** `POST /assistant/ask`:
   - Protegido por el `JwtAuthGuard` existente (cualquier usuario autenticado).
   - Recibe `{ pregunta }`, toma el `rol` del token (no del cliente, por
     seguridad), y reenvía a n8n con el secreto del webhook (variable de entorno
     `N8N_ASSISTANT_URL` + `N8N_ASSISTANT_SECRET`).
   - Devuelve la respuesta. Nunca expone la URL ni el secreto de n8n.
2. **Frontend — widget de chat:** un botón flotante "Asistente" (o `?`) en el
   header, disponible para **todos los roles**. Abre un panel de chat que llama a
   `/assistant/ask`. Se puede reutilizar el estilo de los modales actuales.
3. **Quitar/ocultar `/docs/` navegable:** como la doc no debe estar visible, se
   retira el botón 📖 y las páginas dejan de servirse desde `public/docs/`. La
   documentación pasa a vivir como fuente del bot (un archivo de texto maestro que
   consume n8n, fuera de `public/`).

## Seguridad y privacidad

- **Webhook de n8n autenticado:** exige un secreto en un header; solo el backend
  DISMAP lo conoce. Nunca se expone al navegador.
- **Rol desde el token, no del cliente:** el backend pone el rol; el usuario no
  puede falsear "soy admin" desde el navegador.
- **La doc no se sirve como páginas:** vive solo como fuente del bot.
- **Sin datos sensibles al modelo:** el bot solo recibe la documentación y la
  pregunta; no se le mandan datos de la flota ni de usuarios.

## Variables de entorno nuevas

```
N8N_ASSISTANT_URL=https://n8n.tu-servidor/webhook/dismap-bot
N8N_ASSISTANT_SECRET=<secreto largo y aleatorio>
```
(Y en n8n, la API key del proveedor del modelo — Anthropic — guardada en las
credenciales de n8n, nunca en DISMAP.)

## Sub-fases

| Sub-fase | Alcance |
|---|---|
| **A.0** Montar n8n | Instalar n8n (Docker, junto al stack o aparte) y probar un webhook simple. |
| **A.1** Workflow del bot | Webhook → nodo IA (Claude Haiku) con la doc como contexto → respuesta. Probar desde n8n. |
| **A.2** Proxy + widget | Endpoint `/assistant/ask` en el backend + widget de chat en el frontend, con control de rol. |
| **A.3** Ocultar docs | Retirar las páginas `/docs/` navegables; la doc queda solo como fuente del bot. |
| **B (futuro)** RAG | Si la doc crece: `pgvector` + embeddings + recuperación, workflow de ingesta. |

## Riesgos y decisiones

- **Alucinaciones:** mitigadas por la regla "solo desde la documentación" y por
  pasar la doc completa (enfoque A). Aun así, conviene una nota en el widget:
  "Respuestas generadas por IA a partir de la documentación; ante una duda
  crítica, confirma con tu administrador."
- **Costo:** con Haiku + caché de prompt, muy bajo. Se puede fijar un límite de
  preguntas por usuario/día si hiciera falta.
- **n8n como dependencia:** si n8n cae, el asistente no responde (el resto de
  DISMAP sigue igual). El widget debe mostrar "Asistente no disponible" sin
  romper nada.
- **Mantener la doc actualizada:** en el enfoque A basta con editar el texto
  maestro que consume n8n; en el B hay que reindexar. La fuente del bot debe
  quedar bajo control de versiones junto al proyecto.

---

*Escrito el 25-07-2026. Depende de tener una instancia de n8n disponible. El
enfoque A no requiere base vectorial y se puede montar sobre la documentación
actual (uso, instalación, técnico).*
