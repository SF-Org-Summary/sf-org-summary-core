  export interface TestSummary {
    ApexUnitTests: number;
    TestDuration: number;
    TestMethodsCompleted: number;
    TestMethodsFailed: number;
    TestOutcome: string;
    ApexCoverageDetails: TestCoverageApex;
    FlowCoverageDetails: TestCoverageFlow;
  }
  
  export interface CodeAnalysis {
    LinesOfCode: number;
    Risks: number;
    RisksPerLineRatio: number;
    LineDetails: CodeDetails;
    RiskDetails: ProblemInfo[];
  }
  
  export interface CodeDetails {
    Apex: {
      Total: number;
      Comments: number;
      Code: number;
      Details: {
        ApexClass: { Total: number; Comments: number; Code: number };
        ApexTrigger: { Total: number; Comments: number; Code: number };
      };
    };
    JavaScript: {
      Total: number;
      Comments: number;
      Code: number;
      Details: {
        AuraDefinitionBundle: { Total: number; Comments: number; Code: number };
        LightningComponentBundle: { Total: number; Comments: number; Code: number };
        StaticResource: { Total: number; Comments: number; Code: number };
      };
    };
  }
  
  export interface ProblemInfo {
    Problem: string;
    Severity: string;
    'Normalized Severity': string;
    File: string;
    Line: string;
    Column: string;
    Rule: string;
    Description: string;
    URL: string;
    Category: string;
    Engine: string;
  }
  
  export interface ComponentSummary {
    Total: number | 'N/A';
    LastModifiedDate?: string;
  }
  
  export interface LimitSummary {
    Applicable: number;
    Reached: number;
    Unattained: number;
    Details: Limit[];
  }
  
  export interface FlowCoverage {
    Name: string;
    CoveragePercentage: number | 'N/A';
  }
  
  export interface TestCoverageFlow {
    Total: number | 'N/A';
    Details: FlowCoverage[];
  }
  
  export interface TestCoverageApex {
    Total: number | 'N/A';
    Details: ApexClassCoverage[];
  }
  
  export interface ApexClassCoverage {
    Name: number | 'N/A';
    CoveragePercentage: number | 'N/A';
  }
  
  export interface HealthCheckSummary {
    Score: number | 'N/A';
    Criteria: number | 'N/A';
    Compliant: number | 'N/A';
    Risks: number | 'N/A';
    Details: HealthCheckRisk[];
  
  }
  
  export interface HealthCheckRisk {
    OrgValue: string;
    RiskType: string;
    Setting: string;
    SettingGroup: string;
    SettingRiskCategory: string;
  }
  
  export interface Limit {
    Name: string;
    Description: string;
    Max: number | 'N/A';
    Remaining: number | 'N/A';
    Usage: number | 'N/A';
  }
  
  export interface LinesOfCode {
    Total: number;
    Comments: number;
    Code: number;
  }