# Google Sheets plugin— one container, one endpoint,
# many operations.
#
# Self-contained: pulls @daisy-workflow/plugin-sdk from npm; no
# repo-root build context needed.

FROM node:22-alpine
WORKDIR /workspace

COPY  package.json ./
RUN npm install --omit=dev

COPY . ./

ENV PORT=8080
EXPOSE 8080
USER node

CMD ["node", "index.js"]
