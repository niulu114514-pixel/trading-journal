export type Bindings = Env & {
  CONFIG_ENCRYPTION_KEY: string;
  SETUP_TOKEN?: string;
  REQUEST_DB_SESSION?: D1DatabaseSession;
};

export type Variables = {
  user: { id: number; username: string };
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
