/**
 * The attribution component (private internal module; D60).
 *
 * Attribution names who produced a finding: the SARIF tool (its driver), the
 * tool component that defines the finding's rule when that is an extension
 * rather than the driver, and the rule. One GitHub account may publish
 * feedback from many producers, so every finding carries this line to show
 * readers whose feedback it is. It is producer provenance from the SARIF
 * document: it is never the authenticated GitHub publisher, and it never
 * infers or invents a contributor identity. (A SARIF tool component is a
 * producer concept; it is unrelated to the presentation components of this
 * directory despite the shared word.)
 *
 * Rendered as one line of inline Markdown, every supplied name and version
 * shown literally:
 *
 *   tool [ " " version ] [ " · " component [ " " version ] ] [ " · rule " code span of ruleId ]
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html (3.18 tool, 3.19 toolComponent, 3.27.5 ruleId)
 */

import { codeSpan, escapePlainInline } from './markdown.cjs';

/** A tool component beside the driver: the extension that defines the finding's rule. */
export interface IProducerComponent {
  readonly name: string;
  readonly version?: string;
}

/** Who produced a finding, as the SARIF document states it: tool, optional version, defining extension and rule. */
export interface IProducerAttribution {
  readonly tool: string;
  readonly version?: string;
  readonly component?: IProducerComponent;
  readonly ruleId?: string;
}

/** A name and optional version, each shown literally. */
function named(name: string, version: string | undefined): string {
  return `${escapePlainInline(name)}${version === undefined ? '' : ` ${escapePlainInline(version)}`}`;
}

/** The attribution line of one finding (see the module documentation). */
export function renderAttribution({ tool, version, component, ruleId }: IProducerAttribution): string {
  return `${named(tool, version)}${component === undefined ? '' : ` · ${named(component.name, component.version)}`}`
    + (ruleId === undefined ? '' : ` · rule ${codeSpan(ruleId)}`);
}
