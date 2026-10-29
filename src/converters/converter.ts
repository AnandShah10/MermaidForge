/**
 * Generic shape every diagram-format importer should implement, so adding a
 * new source format (Visio, Lucidchart, PlantUML, ...) means writing a
 * function of this shape, not touching the command that calls it.
 *
 * Only `drawio/` is implemented today — see its module comment for exactly
 * what is and isn't supported. This interface exists now so that boundary is
 * explicit rather than something a future contributor has to reverse-engineer
 * from one converter's code.
 */
export interface ConversionWarning {
  message: string;
  severity: 'info' | 'warning';
}

export interface ConversionResult {
  ok: true;
  mermaid: string;
  warnings: ConversionWarning[];
}

export interface ConversionError {
  ok: false;
  reason: string;
}

export type Converter = (sourceText: string) => ConversionResult | ConversionError;
