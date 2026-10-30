import { v7 as uuidv7 } from 'uuid';
import type { Clock, IdGenerator } from '../application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
