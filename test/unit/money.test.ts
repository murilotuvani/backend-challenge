import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, ValidationError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('aceita decimal com exatamente 2 casas e serializa igual', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0.01').toString()).toBe('0.01');
    expect(brl('999999999999999999.99').toString()).toBe('999999999999999999.99');
  });

  test.each([
    ['vazio', ''],
    ['sem casas', '25'],
    ['uma casa', '25.5'],
    ['três casas', '25.001'],
    ['negativo', '-1.00'],
    ['sinal positivo', '+1.00'],
    ['notação científica', '1e3'],
    ['científica com casas', '1.00e2'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['zero à esquerda', '01.00'],
    ['espaço', ' 1.00'],
    ['vírgula', '1,00'],
    ['overflow de NUMERIC(20,2)', '1000000000000000000.00'],
  ])('rejeita amount inválido: %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(ValidationError);
  });

  test('rejeita amount que não é string (number nunca entra)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(ValidationError);
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(ValidationError);
  });

  test.each(['brl', 'BR', 'BRLL', '', '123'])('rejeita moeda inválida: %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(ValidationError);
  });

  test('aritmética exata, sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
    expect(brl('1.00').subtract(brl('1.01')).toString()).toBe('-0.01');
    expect(brl('5.10').negate().toString()).toBe('-5.10');
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
  });

  test('é imutável: operações devolvem novas instâncias', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(a.toString()).toBe('10.00');
    expect(b).not.toBe(a);
  });

  test('predicados e comparação', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('operações entre moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('rehydrate aceita valores persistidos, inclusive negativos internos', () => {
    expect(Money.rehydrate('975.00', 'BRL').toString()).toBe('975.00');
    expect(Money.rehydrate('-0.50', 'BRL').isNegative()).toBe(true);
    expect(() => Money.rehydrate('1.5', 'BRL')).toThrow(ValidationError);
  });
});
