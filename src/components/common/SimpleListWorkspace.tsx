'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Search } from 'lucide-react';
import { useState, useTransition } from 'react';

export interface SimpleListColumn<T> {
  key: keyof T | string;
  label: string;
  render?: (row: T) => React.ReactNode;
  href?: (row: T) => string;
  className?: string;
}

interface SimpleListWorkspaceProps<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
  basePath: string;
  entityLabel: string;
  entityLabelPlural: string;
  columns: SimpleListColumn<T>[];
  emptyMessage?: string;
}

export function SimpleListWorkspace<T extends { id: string }>({
  rows, total, page, pageSize, totalPages, search, basePath,
  entityLabel, entityLabelPlural, columns, emptyMessage,
}: SimpleListWorkspaceProps<T>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = useState(search);
  const [isPending, startTransition] = useTransition();

  const handleSearch = (value: string) => {
    setSearchValue(value);
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set('search', value); else params.delete('search');
    params.delete('page');
    startTransition(() => router.push(`${basePath}?${params.toString()}`));
  };

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(newPage));
    startTransition(() => router.push(`${basePath}?${params.toString()}`));
  };

  return (
    <div className="app-content">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <Link
            href="/app"
            style={{
              fontSize: '0.875rem',
              color: 'var(--unik-text-muted)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
              marginBottom: '0.5rem',
            }}
          >
            <ArrowLeft size={14} /> Dashboard
          </Link>
          <h1 className="page-title">{entityLabelPlural}</h1>
          <p className="page-description">
            {total} {total === 1 ? entityLabel.toLowerCase() : entityLabelPlural.toLowerCase()}
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ position: 'relative' }}>
          <Search
            size={16}
            style={{
              position: 'absolute', left: '0.75rem', top: '50%',
              transform: 'translateY(-50%)', color: 'var(--unik-text-muted)',
            }}
          />
          <input
            type="search"
            value={searchValue}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={`Buscar ${entityLabelPlural.toLowerCase()}...`}
            className="input"
            style={{ paddingLeft: '2.25rem', width: '100%' }}
            aria-label={`Buscar ${entityLabelPlural.toLowerCase()}`}
          />
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {rows.length === 0 ? (
          <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--unik-text-muted)' }}>
            {emptyMessage ?? `No hay ${entityLabelPlural.toLowerCase()} sincronizados todavía.`}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="w-full" style={{ fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--unik-border-subtle)', background: 'var(--unik-surface-muted)' }}>
                  {columns.map((col) => (
                    <th
                      key={String(col.key)}
                      style={{
                        padding: '0.75rem 1rem',
                        textAlign: 'left',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        color: 'var(--unik-text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.02em',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    style={{ borderBottom: '1px solid var(--unik-border-subtle)' }}
                  >
                    {columns.map((col) => {
                      const href = col.href?.(row);
                      const content = col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key as string] ?? '—');
                      return (
                        <td
                          key={String(col.key)}
                          style={{ padding: '0.75rem 1rem', whiteSpace: 'nowrap', ...col.className ? {} : {} }}
                        >
                          {href ? (
                            <Link href={href} style={{ color: 'var(--unik-text-primary)', textDecoration: 'none', fontWeight: 500 }}>
                              {content}
                            </Link>
                          ) : (
                            content
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totalPages > 1 ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', fontSize: '0.875rem' }}>
          <span style={{ color: 'var(--unik-text-muted)' }}>
            Página {page} de {totalPages} · {total} registros
          </span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => handlePageChange(page - 1)}
              disabled={page <= 1 || isPending}
              aria-label="Página anterior"
            >
              Anterior
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= totalPages || isPending}
              aria-label="Página siguiente"
            >
              Siguiente
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
