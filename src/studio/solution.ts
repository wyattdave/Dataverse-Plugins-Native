import { createHash } from 'node:crypto';
import { contextTables, PARAMETER_TYPE_CODES, TRIGGER_STAGES, type PluginSpec } from './spec.js';

/**
 * Builds an unpacked solution folder (the layout `pac solution unpack` produces) for one low-code plug-in.
 * Component shapes follow Microsoft's published contoso-real-estate-power-platform sample solution.
 */

/** Plug-in type that runs Power Fx expressions (Microsoft.PowerFx.Evaluator, from the msft_PowerfxRuleSolution). */
export const POWER_FX_EVALUATOR_PLUGIN_TYPE_ID = '462b3e8f-beb4-4981-9b87-a60c2162a9f7';
const POWER_FX_EVALUATOR_TYPE_NAME =
  'Microsoft.PowerFx.Evaluator, Microsoft.PowerFx.PlexPlugins, Version=1.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35';

/** Fixed namespace for deterministic step ids so redeploys update the same step instead of adding another. */
const STEP_ID_NAMESPACE = 'b8f6a0e2-5c1d-4f3a-9e7b-2d4c6a8e0f13';

export interface AutomatedBinding {
  sdkMessageId: string;
  stepId: string;
}

export type SolutionFiles = Map<string, string>;

export function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** RFC 4122 version-5 style GUID derived from a name. */
export function deterministicGuid(name: string, namespace = STEP_ID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function defaultStepId(spec: PluginSpec): string {
  return deterministicGuid(`step:${spec.uniqueName.toLowerCase()}`);
}

const label = (tag: string, text: string, indent: string): string =>
  `${indent}<${tag} default="${xmlEscape(text)}">\n${indent}  <label description="${xmlEscape(text)}" languagecode="1033" />\n${indent}</${tag}>`;

function solutionXml(spec: PluginSpec, binding: AutomatedBinding | undefined): string {
  const s = spec.solution;
  const p = s.publisher;
  const roots = binding === undefined ? '    <RootComponents />' : `    <RootComponents>\n      <RootComponent type="92" id="{${binding.stepId}}" behavior="0" />\n    </RootComponents>`;
  const address = (n: number): string =>
    `        <Address>\n          <AddressNumber>${n}</AddressNumber>\n          <AddressTypeCode>1</AddressTypeCode>\n          <ShippingMethodCode>1</ShippingMethodCode>\n        </Address>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${xmlEscape(s.uniqueName)}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${xmlEscape(s.displayName ?? s.uniqueName)}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions />
    <Version>${xmlEscape(s.version ?? '1.0.0.0')}</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${xmlEscape(p.uniqueName)}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${xmlEscape(p.displayName ?? p.uniqueName)}" languagecode="1033" />
      </LocalizedNames>
      <Descriptions />
      <EMailAddress xsi:nil="true"></EMailAddress>
      <SupportingWebsiteUrl xsi:nil="true"></SupportingWebsiteUrl>
      <CustomizationPrefix>${xmlEscape(p.prefix)}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>${p.optionValuePrefix}</CustomizationOptionValuePrefix>
      <Addresses>
${address(1)}
${address(2)}
      </Addresses>
    </Publisher>
${roots}
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>
`;
}

const CUSTOMIZATIONS_XML = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <CustomControls />
  <SolutionPluginAssemblies />
  <SdkMessageProcessingSteps />
  <EntityDataProviders />
  <Languages>
    <Language>1033</Language>
  </Languages>
</ImportExportXml>
`;

function fxExpressionJson(spec: PluginSpec): string {
  const context = {
    Tables: contextTables(spec),
    CustomApis: [],
    ConnectionReferences: [],
    TabularConnectionReferences: [],
    ActionConnectorConnectionReferences: [],
  };
  const record: Record<string, string> = {
    '@uniquename': spec.uniqueName,
    category: '0',
    context: JSON.stringify(context),
  };
  if (spec.trigger !== undefined) {
    record['entitylogicalname'] = spec.trigger.table;
  }
  record['iscustomizable'] = '1';
  if (spec.trigger !== undefined) {
    record['messagename'] = spec.trigger.message;
  }
  record['name'] = spec.displayName;
  if (spec.kind === 'instant') {
    const params = spec.parameters ?? [];
    record['parameters'] = JSON.stringify({
      InputParameter: params.filter((p) => p.direction === 'input').map((p) => ({ isOptional: 0, name: p.name, type: PARAMETER_TYPE_CODES[p.type] })),
      OutputParameter: params.filter((p) => p.direction === 'output').map((p) => ({ name: p.name, type: PARAMETER_TYPE_CODES[p.type] })),
    });
  }
  record['statecode'] = '0';
  record['statuscode'] = '1';
  return `${JSON.stringify({ fxexpression: record }, null, 2)}\n`;
}

function customApiXml(spec: PluginSpec): string {
  return `<customapi uniquename="${xmlEscape(spec.uniqueName)}">
  <allowedcustomprocessingsteptype>1</allowedcustomprocessingsteptype>
  <bindingtype>0</bindingtype>
${label('description', spec.description ?? spec.displayName, '  ')}
${label('displayname', spec.displayName, '  ')}
  <fxexpressionid>
    <uniquename>${xmlEscape(spec.uniqueName)}</uniquename>
  </fxexpressionid>
  <iscustomizable>1</iscustomizable>
  <isfunction>0</isfunction>
  <isprivate>0</isprivate>
  <name>${xmlEscape(spec.displayName)}</name>
  <plugintypeid>
    <plugintypeexportkey>${POWER_FX_EVALUATOR_PLUGIN_TYPE_ID}</plugintypeexportkey>
  </plugintypeid>
  <workflowsdkstepenabled>0</workflowsdkstepenabled>
</customapi>
`;
}

function parameterXml(tag: 'customapirequestparameter' | 'customapiresponseproperty', name: string, typeCode: number): string {
  const optional = tag === 'customapirequestparameter' ? '  <isoptional>0</isoptional>\n' : '';
  return `<${tag} uniquename="${xmlEscape(name)}">
${label('description', name, '  ')}
${label('displayname', name, '  ')}
  <iscustomizable>1</iscustomizable>
${optional}  <name>${xmlEscape(name)}</name>
  <type>${typeCode}</type>
</${tag}>
`;
}

function stepXml(spec: PluginSpec, binding: AutomatedBinding): string {
  const trigger = spec.trigger!;
  return `<?xml version="1.0" encoding="utf-8"?>
<SdkMessageProcessingStep Name="${xmlEscape(spec.displayName)}" SdkMessageProcessingStepId="{${binding.stepId}}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SdkMessageId>${binding.sdkMessageId}</SdkMessageId>
  <PluginTypeName>${POWER_FX_EVALUATOR_TYPE_NAME}</PluginTypeName>
  <PluginTypeId>${POWER_FX_EVALUATOR_PLUGIN_TYPE_ID}</PluginTypeId>
  <fxexpressionid>
    <uniquename>${xmlEscape(spec.uniqueName)}</uniquename>
  </fxexpressionid>
  <PrimaryEntity>${xmlEscape(trigger.table)}</PrimaryEntity>
  <AsyncAutoDelete>0</AsyncAutoDelete>
  <FilteringAttributes></FilteringAttributes>
  <InvocationSource>1</InvocationSource>
  <Mode>0</Mode>
  <Rank>1</Rank>
  <EventHandlerTypeCode>4602</EventHandlerTypeCode>
  <Stage>${TRIGGER_STAGES[trigger.stage]}</Stage>
  <IsCustomizable>1</IsCustomizable>
  <IsHidden>0</IsHidden>
  <SupportedDeployment>0</SupportedDeployment>
  <IntroducedVersion>1.0.0.0</IntroducedVersion>
  <SdkMessageProcessingStepImages />
</SdkMessageProcessingStep>
`;
}

/** Returns relative path (forward slashes) to file content. Automated plug-ins need the resolved message and step ids. */
export function buildSolutionFiles(spec: PluginSpec, binding?: AutomatedBinding): SolutionFiles {
  if (spec.kind === 'automated' && binding === undefined) {
    throw new Error('Automated plug-ins need the SDK message id and step id.');
  }
  const files: SolutionFiles = new Map();
  const automated = spec.kind === 'automated' ? binding : undefined;
  files.set('Other/Solution.xml', solutionXml(spec, automated));
  files.set('Other/Customizations.xml', CUSTOMIZATIONS_XML);
  const fx = `fxexpressions/${spec.uniqueName}`;
  files.set(`${fx}/fxexpression.json`, fxExpressionJson(spec));
  files.set(`${fx}/expression.yaml`, spec.formula.replace(/\r\n?/g, '\n'));
  if (spec.kind === 'instant') {
    const api = `customapis/${spec.uniqueName}`;
    files.set(`${api}/customapi.xml`, customApiXml(spec));
    for (const p of spec.parameters ?? []) {
      const code = PARAMETER_TYPE_CODES[p.type];
      if (p.direction === 'input') {
        files.set(`${api}/customapirequestparameters/${p.name}/customapirequestparameter.xml`, parameterXml('customapirequestparameter', p.name, code));
      } else {
        files.set(`${api}/customapiresponseproperties/${p.name}/customapiresponseproperty.xml`, parameterXml('customapiresponseproperty', p.name, code));
      }
    }
  } else {
    files.set(`SdkMessageProcessingSteps/{${automated!.stepId}}.xml`, stepXml(spec, automated!));
  }
  return files;
}
