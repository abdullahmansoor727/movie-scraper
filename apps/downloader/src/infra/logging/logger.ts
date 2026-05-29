type LogFields = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', component: string, message: string, fields?: LogFields): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...(fields || {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function createLogger(component: string) {
  return {
    info(message: string, fields?: LogFields): void {
      emit('info', component, message, fields);
    },
    warn(message: string, fields?: LogFields): void {
      emit('warn', component, message, fields);
    },
    error(message: string, fields?: LogFields): void {
      emit('error', component, message, fields);
    },
  };
}
