/** Abstrai `new Date()` para tornar as regras dependentes de tempo testáveis. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
