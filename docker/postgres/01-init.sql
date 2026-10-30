-- Executado uma única vez pelo entrypoint oficial do Postgres, como superusuário,
-- na primeira inicialização do volume.
create user chimp with password 'CaptainFox&Parrot';
create database jungle owner chimp;

-- Banco separado para o Keycloak, isolado do banco financeiro.
create user keycloak with password 'keycloak';
create database keycloak owner keycloak;

-- Banco isolado para os testes de integração in-process (schema recriado a cada suíte),
-- para não interferir nas instâncias que usam o banco "jungle".
create database jungle_test owner chimp;
