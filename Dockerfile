FROM node:24-alpine
ENV NODE_ENV=production PORT=9000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js brain.js commands.js drill.js auth.js ./
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
COPY public ./public
USER 1000:1000
EXPOSE 9000
CMD ["node", "server.js"]
