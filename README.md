# Casino de Cartel Mexicano Nueva Generación — Telegram Mini App

Esto es tu casino corriendo dentro de Telegram: blackjack y ruleta con
saldos reales guardados en una base de datos, ligados a la cuenta de
Telegram de cada apostador (nadie puede hacer trampa editando su
celular, porque todo el juego corre en el servidor).

## Qué incluye

- `server.js` — el servidor (verifica que cada jugador es quien dice
  ser en Telegram, guarda saldos, corre la lógica de blackjack y ruleta).
- `public/index.html` — la mesa principal (lobby).
- `public/blackjack.html` y `public/roulette.html` — los juegos.
- `public/admin.html` — tu panel de dealer para recargar saldo a
  cualquier jugador.
- `casino.db` — se crea solo la primera vez que corres el servidor
  (ahí viven todos los saldos).

## Paso 1 — Crear tu bot en Telegram

1. Abre una conversación con **@BotFather** en Telegram.
2. Manda `/newbot`, dale un nombre y un usuario (debe terminar en "bot",
   ej. `CartelMexicanoCasinoBot`).
3. BotFather te va a dar un **token** — cópialo, lo vas a necesitar.

## Paso 2 — Subir el proyecto a un hosting

Necesitas un lugar donde este código corra 24/7 con una URL **https**
(Telegram exige https). Opciones gratuitas o muy baratas para empezar:
**Render.com**, **Railway.app** o **Fly.io**. Los tres funcionan así:

1. Crea una cuenta.
2. Conecta este proyecto (puedes subirlo a GitHub primero, o algunos
   te dejan subir el folder directo).
3. En "Environment Variables" (variables de entorno) agrega:
   - `BOT_TOKEN` = el token que te dio BotFather
   - `ADMIN_SECRET` = una clave que tú inventes, solo tú la vas a usar
     para entrar a `admin.html`
4. El comando de arranque es `npm install && npm start`.
5. Cuando termine el despliegue, te van a dar una URL como
   `https://tu-casino.onrender.com`.

## Paso 3 — Conectar la Mini App a tu bot

1. Vuelve a **@BotFather**.
2. Manda `/mybots`, elige tu bot.
3. Entra a **Bot Settings → Menu Button → Configure Menu Button**.
4. Pégale la URL que te dio tu hosting (ej.
   `https://tu-casino.onrender.com`).
5. Ponle un texto al botón, por ejemplo "🎰 Abrir casino".

Listo — ahora, cuando cualquiera de tus apostadores abra un chat con
tu bot, va a ver el botón "🎰 Abrir casino" y al tocarlo se abre tu
mesa dentro de Telegram, con su nombre y saldo ya identificados.

## Paso 4 — Recargar saldo a tus jugadores

1. Pídele a cada apostador que abra el bot al menos una vez (así el
   sistema los registra).
2. Entra tú a `https://tu-casino.onrender.com/admin.html`.
3. Escribe tu `ADMIN_SECRET`, dale "Ver jugadores".
4. Selecciona el jugador y el monto, dale "Recargar".

## Cambiar los pagos o el juego más adelante

- Los pagos de la ruleta (x2 color, x5 número, x10 el cero) y la
  probabilidad del cero están en `server.js`, en la sección
  `RULETA` — busca `ZERO_WEIGHT` y las líneas `mult = 2 / 5 / 10`.
- Las reglas de blackjack están en la sección `BLACKJACK` del mismo
  archivo.

## Nota importante de seguridad

Guarda tu `ADMIN_SECRET` solo para ti — cualquiera que la tenga puede
recargar saldo ilimitado a cualquier jugador. No la compartas en el
grupo de WhatsApp ni de Telegram.
