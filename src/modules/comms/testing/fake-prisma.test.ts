import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { FakePrisma, type RawQuery, type Relation, type Row } from './fake-prisma';

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err
  );
}

async function expectP2002(promise: Promise<unknown>, target?: string[]): Promise<void> {
  const err = await captureError(promise);
  expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  const known = err as Prisma.PrismaClientKnownRequestError;
  expect(known.code).toBe('P2002');
  if (target) expect(known.meta?.target).toEqual(target);
}

describe('FakePrisma · compatibilidad con los usos actuales', () => {
  it('conserva la unicidad de commMessage y commAccount', async () => {
    const fake = new FakePrisma();
    await fake.client.commMessage.create({ data: { accountId: 'a1', externalId: 'x1' } });
    await expectP2002(
      fake.client.commMessage.create({ data: { accountId: 'a1', externalId: 'x1' } }),
      ['accountId', 'externalId']
    );
    // Sin externalId no hay restricción.
    await fake.client.commMessage.create({ data: { accountId: 'a1' } });
    await fake.client.commMessage.create({ data: { accountId: 'a1' } });
    expect(fake.rows('commMessage')).toHaveLength(3);

    await fake.client.commAccount.create({ data: { provider: 'twilio', identifier: '+52' } });
    await expectP2002(
      fake.client.commAccount.create({ data: { provider: 'twilio', identifier: '+52' } }),
      ['provider', 'identifier']
    );
  });

  it('aplica los defaults, relaciones y llaves compuestas integradas', async () => {
    const fake = new FakePrisma();
    const account = fake.seed('commAccount', { provider: 'twilio', identifier: '1' });
    const conversation = fake.seed('commConversation', { accountId: account.id });
    const found = await fake.client.commConversation.findUnique({
      where: { id: conversation.id },
      include: { account: true },
    });
    expect(found.status).toBe('open');
    expect(found.account.id).toBe(account.id);

    const byCompound = await fake.client.commAccount.findUnique({
      where: { provider_identifier: { provider: 'twilio', identifier: '1' } },
    });
    expect(byCompound.id).toBe(account.id);
  });

  it('no convierte al cliente en thenable y $transaction entrega el mismo cliente', async () => {
    const fake = new FakePrisma();
    expect(fake.client.then).toBeUndefined();
    await expect(Promise.resolve(fake.client)).resolves.toBe(fake.client);

    const seen = await fake.client.$transaction(async (tx: Row) => tx);
    expect(seen).toBe(fake.client);
    const results = await fake.client.$transaction([
      fake.client.widget.create({ data: { name: 'a' } }),
      fake.client.widget.count(),
    ]);
    expect(results[0].name).toBe('a');
  });

  it('update y delete lanzan P2025 si no existe el registro', async () => {
    const fake = new FakePrisma();
    const err = await captureError(fake.client.commNote.update({ where: { id: 'x' }, data: {} }));
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2025');
    const notFound = await captureError(
      fake.client.commNote.findUniqueOrThrow({ where: { id: 'x' } })
    );
    expect((notFound as Prisma.PrismaClientKnownRequestError).code).toBe('P2025');
  });
});

describe('FakePrisma · modelos al vuelo y opciones', () => {
  it('permite usar modelos no declarados con defaults vacíos', async () => {
    const fake = new FakePrisma();
    expect(fake.client.widget).toBe(fake.client.widget);
    const created = await fake.client.widget.create({ data: { name: 'Lámina', stock: 3 } });
    expect(created.id).toMatch(/^widget_/);
    expect(created.createdAt).toBeInstanceOf(Date);
    const found = await fake.client.widget.findMany({ where: { stock: { gte: 3 } } });
    expect(found).toEqual([created]);
  });

  it('fusiona defaults, relaciones y llaves compuestas del constructor', async () => {
    const lines: Relation = { model: 'invoiceLine', childFk: 'invoiceId' };
    const fake = new FakePrisma({
      defaults: {
        invoiceLine: () => ({ quantity: 1, status: 'open' }),
        user: () => ({ isActive: false, email: null }),
      },
      relations: {
        invoice: { lines },
        invoiceLine: { invoice: { model: 'invoice', fk: 'invoiceId' } },
        commMessage: { sender: { model: 'user', fk: 'sentByUserId' } },
      },
      compoundKeys: { tenantId_folio: ['tenantId', 'folio'] },
    });

    const invoice = await fake.client.invoice.create({ data: { tenantId: 't1', folio: 'F-1' } });
    await fake.client.invoiceLine.create({ data: { invoiceId: invoice.id } });
    const withLines = await fake.client.invoice.findUnique({
      where: { tenantId_folio: { tenantId: 't1', folio: 'F-1' } },
      include: { lines: true },
    });
    expect(withLines.lines).toHaveLength(1);
    expect(withLines.lines[0]).toMatchObject({ quantity: 1, status: 'open' });

    // Los defaults del constructor ganan; las relaciones integradas siguen.
    expect(fake.seed('user', {}).isActive).toBe(false);
    const user = fake.seed('user', { name: 'Ana' });
    const account = fake.seed('commAccount', { provider: 'p', identifier: 'i' });
    const conversation = fake.seed('commConversation', { accountId: account.id });
    const message = fake.seed('commMessage', {
      accountId: account.id,
      conversationId: conversation.id,
      sentByUserId: user.id,
    });
    const loaded = await fake.client.commMessage.findFirst({
      where: { id: message.id, sender: { name: 'Ana' } },
      include: { sender: true, conversation: true },
    });
    expect(loaded.sender.id).toBe(user.id);
    expect(loaded.conversation.id).toBe(conversation.id);
  });
});

describe('FakePrisma · unicidad declarada', () => {
  function build() {
    return new FakePrisma({ uniques: { sku: [['code'], ['tenantId', 'barcode']] } });
  }

  it('lanza P2002 al crear duplicados e ignora valores nulos', async () => {
    const fake = build();
    await fake.client.sku.create({ data: { code: 'A', tenantId: 't1', barcode: '001' } });
    await expectP2002(fake.client.sku.create({ data: { code: 'A' } }), ['code']);
    await expectP2002(
      fake.client.sku.create({ data: { code: 'B', tenantId: 't1', barcode: '001' } }),
      ['tenantId', 'barcode']
    );
    await fake.client.sku.create({ data: { code: null, tenantId: 't1', barcode: null } });
    await fake.client.sku.create({ data: { code: null, tenantId: 't1', barcode: null } });
    await fake.client.sku.create({ data: { code: 'C', tenantId: 't2', barcode: '001' } });
    expect(fake.rows('sku')).toHaveLength(4);
  });

  it('registra la llave compuesta de cada conjunto único', async () => {
    const fake = build();
    const row = await fake.client.sku.create({ data: { code: 'A', tenantId: 't1', barcode: '9' } });
    const found = await fake.client.sku.findUnique({
      where: { tenantId_barcode: { tenantId: 't1', barcode: '9' } },
    });
    expect(found.id).toBe(row.id);
  });

  it('valida update, updateMany y upsert sin dejar cambios a medias', async () => {
    const fake = build();
    const a = await fake.client.sku.create({ data: { code: 'A', status: 'active' } });
    const b = await fake.client.sku.create({ data: { code: 'B', status: 'active' } });

    await expectP2002(fake.client.sku.update({ where: { id: b.id }, data: { code: 'A' } }));
    expect(fake.rows('sku').find((r) => r.id === b.id)?.code).toBe('B');

    await expectP2002(
      fake.client.sku.updateMany({ where: { status: 'active' }, data: { code: 'Z' } })
    );
    expect(fake.rows('sku').map((r) => r.code)).toEqual(['A', 'B']);

    await expectP2002(
      fake.client.sku.upsert({ where: { id: 'nuevo' }, create: { code: 'A' }, update: {} })
    );
    await expectP2002(
      fake.client.sku.upsert({ where: { id: b.id }, create: {}, update: { code: 'A' } })
    );

    const res = await fake.client.sku.updateMany({ where: { id: a.id }, data: { status: 'x' } });
    expect(res.count).toBe(1);
  });

  it('impide ids duplicados', async () => {
    const fake = new FakePrisma();
    await fake.client.widget.create({ data: { id: 'w1' } });
    await expectP2002(fake.client.widget.create({ data: { id: 'w1' } }), ['id']);
  });
});

describe('FakePrisma · createMany', () => {
  it('inserta con defaults y devuelve el conteo', async () => {
    const fake = new FakePrisma({ defaults: { movement: () => ({ status: 'posted' }) } });
    const res = await fake.client.movement.createMany({
      data: [{ quantity: 1 }, { quantity: 2 }],
    });
    expect(res).toEqual({ count: 2 });
    expect(fake.rows('movement').map((r) => r.status)).toEqual(['posted', 'posted']);
  });

  it('omite duplicados con skipDuplicates (existentes y dentro del lote)', async () => {
    const fake = new FakePrisma({ uniques: { movement: [['commandId']] } });
    await fake.client.movement.create({ data: { commandId: 'c1' } });
    const res = await fake.client.movement.createMany({
      data: [{ commandId: 'c1' }, { commandId: 'c2' }, { commandId: 'c2' }, { commandId: 'c3' }],
      skipDuplicates: true,
    });
    expect(res.count).toBe(2);
    expect(fake.rows('movement').map((r) => r.commandId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('sin skipDuplicates lanza P2002 y no inserta nada del lote', async () => {
    const fake = new FakePrisma({ uniques: { movement: [['commandId']] } });
    await expectP2002(
      fake.client.movement.createMany({ data: [{ commandId: 'c1' }, { commandId: 'c1' }] })
    );
    expect(fake.rows('movement')).toHaveLength(0);
  });

  it('createManyAndReturn proyecta las filas creadas', async () => {
    const fake = new FakePrisma();
    const rows = await fake.client.movement.createManyAndReturn({
      data: [{ quantity: 5, note: 'x' }],
      select: { quantity: true },
    });
    expect(rows).toEqual([{ quantity: 5 }]);
  });
});

describe('FakePrisma · aggregate y groupBy', () => {
  function seedPayments(fake: FakePrisma) {
    fake.seed('payment', { status: 'paid', amount: 100, method: 'cash' });
    fake.seed('payment', { status: 'paid', amount: 50, method: 'card' });
    fake.seed('payment', { status: 'pending', amount: 25, method: null });
    fake.seed('payment', { status: 'paid', amount: null, method: null });
  }

  it('calcula _count, _sum, _avg, _min y _max con filtro', async () => {
    const fake = new FakePrisma();
    seedPayments(fake);
    const res = await fake.client.payment.aggregate({
      where: { status: 'paid' },
      _count: true,
      _sum: { amount: true },
      _avg: { amount: true },
      _min: { amount: true },
      _max: { amount: true },
    });
    expect(res).toEqual({
      _count: 3,
      _sum: { amount: 150 },
      _avg: { amount: 75 },
      _min: { amount: 50 },
      _max: { amount: 100 },
    });

    const counts = await fake.client.payment.aggregate({ _count: { _all: true, method: true } });
    expect(counts._count).toEqual({ _all: 4, method: 2 });

    const empty = await fake.client.payment.aggregate({
      where: { status: 'void' },
      _count: true,
      _sum: { amount: true },
    });
    expect(empty).toEqual({ _count: 0, _sum: { amount: null } });
  });

  it('suma Prisma.Decimal y filtra por igualdad decimal', async () => {
    const fake = new FakePrisma();
    fake.seed('ledger', { amount: new Prisma.Decimal('10.25') });
    fake.seed('ledger', { amount: new Prisma.Decimal('2.25') });
    const res = await fake.client.ledger.aggregate({ _sum: { amount: true } });
    expect(Prisma.Decimal.isDecimal(res._sum.amount)).toBe(true);
    expect(res._sum.amount.toString()).toBe('12.5');
    const found = await fake.client.ledger.findFirst({
      where: { amount: new Prisma.Decimal('2.250') },
    });
    expect(found.amount.toString()).toBe('2.25');
  });

  it('agrupa por campos con _count y _sum', async () => {
    const fake = new FakePrisma();
    seedPayments(fake);
    const groups = await fake.client.payment.groupBy({
      by: ['status'],
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: { status: 'asc' },
    });
    expect(groups).toEqual([
      { status: 'paid', _count: { _all: 3 }, _sum: { amount: 150 } },
      { status: 'pending', _count: { _all: 1 }, _sum: { amount: 25 } },
    ]);

    const top = await fake.client.payment.groupBy({
      by: ['method'],
      where: { method: { not: null } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 1,
    });
    expect(top).toEqual([{ method: 'cash', _sum: { amount: 100 } }]);
  });

  it('rechaza groupBy con having', async () => {
    const fake = new FakePrisma();
    await expect(
      fake.client.payment.groupBy({ by: ['status'], having: { status: 'paid' } })
    ).rejects.toThrow(/having/);
  });
});

describe('FakePrisma · operaciones numéricas', () => {
  it('incrementa y decrementa en update, updateMany y upsert', async () => {
    const fake = new FakePrisma();
    const row = fake.seed('counter', { value: 5, other: 1 });
    await fake.client.counter.update({
      where: { id: row.id },
      data: { value: { increment: 3 }, other: { decrement: 2 } },
    });
    expect(fake.rows('counter')[0]).toMatchObject({ value: 8, other: -1 });

    fake.seed('counter', { value: 1, other: 0 });
    const res = await fake.client.counter.updateMany({ data: { value: { multiply: 2 } } });
    expect(res.count).toBe(2);
    expect(fake.rows('counter').map((r) => r.value)).toEqual([16, 2]);

    await fake.client.counter.upsert({
      where: { id: row.id },
      create: { value: 0 },
      update: { value: { divide: 4 } },
    });
    expect(fake.rows('counter')[0].value).toBe(4);
  });

  it('opera con Prisma.Decimal', async () => {
    const fake = new FakePrisma();
    const row = fake.seed('stock', { onHand: new Prisma.Decimal('1.5') });
    await fake.client.stock.update({
      where: { id: row.id },
      data: { onHand: { increment: new Prisma.Decimal('0.25') } },
    });
    expect(fake.rows('stock')[0].onHand.toString()).toBe('1.75');
    await fake.client.stock.update({
      where: { id: row.id },
      data: { onHand: { decrement: 1 } },
    });
    expect(fake.rows('stock')[0].onHand.toString()).toBe('0.75');
  });
});

describe('FakePrisma · SQL crudo', () => {
  it('rechaza $queryRaw y $executeRaw sin manejador registrado', async () => {
    const fake = new FakePrisma();
    await expect(fake.client.$queryRaw`SELECT 1`).rejects.toThrow(/fake\.onRaw/);
    await expect(fake.client.$executeRaw`DELETE FROM "X"`).rejects.toThrow(/\$executeRaw/);
  });

  it('entrega SQL y valores al manejador registrado con onRaw', async () => {
    const fake = new FakePrisma();
    const calls: RawQuery[] = [];
    const returned = fake.onRaw((query) => {
      calls.push(query);
      return query.method === '$queryRaw' ? [{ id: 'j1' }] : 1;
    });
    expect(returned).toBe(fake);

    const status = 'pending';
    const rows = await fake.client
      .$queryRaw`SELECT "id" FROM "BackgroundJob" WHERE "status" = ${status} AND "type" IN (${Prisma.join(['a', 'b'])})`;
    expect(rows).toEqual([{ id: 'j1' }]);
    expect(calls[0]).toEqual({
      method: '$queryRaw',
      sql: 'SELECT "id" FROM "BackgroundJob" WHERE "status" = $1 AND "type" IN ($2,$3)',
      values: ['pending', 'a', 'b'],
    });

    const count = await fake.client.$executeRaw(Prisma.sql`UPDATE "X" SET "n" = ${2}`);
    expect(count).toBe(1);
    expect(calls[1]).toEqual({
      method: '$executeRaw',
      sql: 'UPDATE "X" SET "n" = $1',
      values: [2],
    });

    await fake.client.$queryRawUnsafe('SELECT $1::int', 7);
    expect(calls[2]).toEqual({ method: '$queryRawUnsafe', sql: 'SELECT $1::int', values: [7] });

    fake.onRaw(null);
    await expect(fake.client.$queryRaw`SELECT 1`).rejects.toThrow(/onRaw/);
  });
});
