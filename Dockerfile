FROM node:24-alpine AS assets
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY frontend ./frontend
COPY scripts ./scripts
COPY public/observability-privacy.js ./public/observability-privacy.js
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production PORT=9000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js brain.js commands.js drill.js auth.js preview.js ./
COPY llm ./llm
COPY tts ./tts
COPY mcp ./mcp
COPY boards ./boards
COPY alerts ./alerts
COPY home ./home
COPY evidence ./evidence
COPY changes ./changes
COPY coverage ./coverage
COPY telemetry ./telemetry
COPY incidents ./incidents
COPY snooze ./snooze
COPY config ./config
COPY traces ./traces
COPY aiden ./aiden
COPY fixes ./fixes
COPY timeline ./timeline
COPY memory ./memory
COPY self ./self
COPY capabilities ./capabilities
COPY held ./held
COPY tasks ./tasks
COPY game ./game
COPY scorecard ./scorecard
COPY knowhow ./knowhow
COPY confidence ./confidence
COPY resume ./resume
COPY identity ./identity
COPY steps ./steps
COPY personas ./personas
COPY public ./public
COPY --from=assets /build/public/assets ./public/assets
USER 1000:1000
EXPOSE 9000
CMD ["node", "--import", "./telemetry/bootstrap.js", "server.js"]
