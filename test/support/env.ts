/**
 * Endereços usados pelos testes. Os defaults valem dentro do container `test` (rede jungle);
 * de fora, sobrescreva com as portas publicadas (ver README).
 */
export const env = {
  appUrls: (process.env.APP_URLS ?? 'http://app-1:3000,http://app-2:3000,http://app-3:3000').split(','),
  keycloakUrl: process.env.KEYCLOAK_URL ?? 'http://keycloak:8080',
  sqsEndpoint: process.env.SQS_ENDPOINT ?? 'http://localstack:4566',
  /** Banco usado pelas instâncias em execução (testes caixa-preta). */
  appDbName: process.env.DB_NAME ?? 'jungle',
  /** Banco isolado dos testes in-process (schema recriado). */
  testDbName: process.env.TEST_DB_NAME ?? 'jungle_test',
  dockerSocket: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  composeProject: process.env.COMPOSE_PROJECT ?? 'jungle-wagering',
};
