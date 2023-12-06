import { execSync } from 'node:child_process';
import fs = require('fs');
import path from 'path';
import axios from 'axios';
import parse = require('csv-parse/lib/sync');
import { ApexClassCoverage, CodeDetails, ComponentSummary, FlowCoverage, HealthCheckRisk, HealthCheckSummary, Limit, ProblemInfo } from './models/summary';
import { countCodeLines } from './libs/CountCodeLines';
import { dataPoints } from './data/DataPoints';
import { CodeAnalysis, LimitSummary, TestSummary, TestCoverageApex, TestCoverageFlow } from './models/summary';
import * as fse from 'fs-extra';

export interface flags {
    outputdirectory?: string;
    metadata?: string;
    keepdata?: boolean;
    healthcheck?: boolean;
    limits?: boolean;
    codeanalysis?: boolean;
    tests?: boolean;
    targetusername?: string;
}

export async function buildBaseSummary(info: OrgInfo){
    const currentDate = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    const timestamp = Date.now().toString();
    
    const baseSummary: OrgSummary = {
        DateOfSummary: currentDate,
        Timestamp: timestamp,
        ResultState: 'Pending',
        OrgId: info.orgId,
        Username: info.username,
        OrgInstanceURL: info.instanceUrl,
    };
    return baseSummary;
}

export async function summarizeOrg(flags: flags, orgSummary?: OrgSummary): Promise<OrgSummary> {

    const orgAlias = flags.targetusername ?? undefined;
    const info = getOrgInfo(orgAlias);
    const baseSummary = orgSummary || (await buildBaseSummary(info));
   
    const keepData = flags.keepdata ? flags.keepdata : false;
    const healthCheck = flags.healthcheck;
    const limits = flags.limits;
    const tests = flags.tests;
    const codeAnalysis = flags.codeanalysis;
    const selectedDataPoints = flags.metadata ? flags.metadata.split(',') : dataPoints;
    let orgSummaryDirectory;
    if(!flags.outputdirectory){
        orgSummaryDirectory = __dirname + `/${info.orgId}/${baseSummary.Timestamp}`; 
    } else {
        orgSummaryDirectory = (flags.outputdirectory) + `/${info.orgId}/${baseSummary.Timestamp}`;
    }
    if (!fs.existsSync(orgSummaryDirectory)) {
        fs.mkdirSync(orgSummaryDirectory, { recursive: true });
    }    
    const errors: any[] = [];

    if (healthCheck) {
        try {
            baseSummary.HealthCheck = getHealthCheckScore(orgSummaryDirectory, orgAlias);
        } catch (error) {
            errors.push({ getHealthCheckScoreError: error.message });
        }
    }

    if (limits) {
        try {
            const limits = await checkLimits(info.instanceUrl, info.accessToken);
            const Applicable: number = limits ? limits.length : 0;
            const Reached: number = limits ? limits.filter((limit) => limit.Remaining === 0).length : 0;
            baseSummary.Limits = {
                Applicable,
                Reached,
                'Unattained': (Applicable - Reached),
                'Details': limits
            };
        } catch (error) {
            errors.push({ checkLimitsError: error.message });
        }
    }

    if (codeAnalysis) {
        try {
            process.chdir(orgSummaryDirectory);
            execSync('sfdx force:project:create -x -n tempSFDXProject');
            process.chdir('./tempSFDXProject');
            const retrieveCommand = orgAlias ? `sf project retrieve start --metadata ApexClass ApexTrigger AuraDefinitionBundle LightningComponentBundle StaticResource --target-org ${orgAlias}` :
                'sf project retrieve start --metadata ApexClass ApexTrigger AuraDefinitionBundle LightningComponentBundle StaticResource';
            execSync(retrieveCommand, { encoding: 'utf8' });
            execSync('sfdx scanner:run --target . --format csv --normalize-severity > CLIScannerResults.csv');
            const results = preprocessResults();
            const codeLines = calculateCodeLines();
            baseSummary.Code = { 'Risks': results.length, 'RiskDetails': results, 'LinesOfCode': (codeLines.Apex.Total + codeLines.JavaScript.Total), 'RisksPerLineRatio': results.length / (codeLines.Apex.Total + codeLines.JavaScript.Total), 'LineDetails': codeLines };
            process.chdir('../../../../');
        } catch (error) {
            errors.push({ calculateLinesOfCodeError: error.message });
        }
    }

    if (tests) {
        try {
            const testResultsCommand = `sfdx force:apex:test:run --target-org "${orgAlias}" --test-level RunLocalTests --code-coverage --result-format json > ${orgSummaryDirectory}/testResults.json`;
            execSync(testResultsCommand, { encoding: 'utf8' });
            const testRunId = extractTestRunId(`${orgSummaryDirectory}/testResults.json`);
            if (testRunId) {
                console.log(`Checking Status of Apex Test Job "${testRunId}"...`);
                await pollTestRunResult(testRunId, orgSummaryDirectory, orgAlias);
                const testResult = await getTestRunDetails(testRunId, orgSummaryDirectory, orgAlias);
                const orgWideApexCoverage = await getOrgWideApexCoverage(orgSummaryDirectory, orgAlias);
                const orgWideFlowCoverage = await getFlowCoveragePercentage(orgAlias);
                const flowCoverageDetails = await getFlowCoverageDetails(orgAlias) as FlowCoverage[];
                baseSummary.Tests = {
                    ApexUnitTests: testResult?.methodsCompleted ?? 0,
                    TestDuration: testResult?.runtime.toString() ?? 'N/A',
                    TestMethodsCompleted: testResult?.methodsCompleted ?? 0,
                    TestMethodsFailed: testResult?.methodsFailed ?? 0,
                    TestOutcome: testResult?.outcome ?? 'N/A',
                    ApexTestCoverage: {
                        'Total': orgWideApexCoverage ?? 0,
                        'Details': await getApexClassCoverageDetails(orgSummaryDirectory, orgAlias),
                    },
                    FlowTestCoverage: {
                        'Total': orgWideFlowCoverage ?? 0,
                        'Details': flowCoverageDetails
                    }
                };
            }
        } catch (error) {
            errors.push({ runApexTestsError: error.message });
        }
    }

    if (selectedDataPoints && selectedDataPoints.length > 0) {
        console.log(`Processing components: ${selectedDataPoints.join(', ')}`);
        try {
            const queryResults = queryDataPoints(selectedDataPoints, orgSummaryDirectory, orgAlias);
            baseSummary.Metadata = calculateComponentSummary(selectedDataPoints, queryResults, errors);
        } catch (error) {
            errors.push({ componentSummaryError: error.message });
        }
    }

    baseSummary.ResultState = errors.length > 0 ? 'Failure' : 'Completed';
    const summary: OrgSummary = {
        ...baseSummary
    };
    finish(orgSummaryDirectory, summary, keepData, flags.outputdirectory);
    if(flags.outputdirectory){
        summary.OutputPath = flags.outputdirectory;
    }
    return summary;
}

function finish(orgSummaryDirectory: string, summarizedOrg: OrgSummary, keepData: boolean, outputDirectory?: string) {
    if (!keepData) {
        const cleanUpDirectory = () => {
            const files = fs.readdirSync(orgSummaryDirectory);
            for (const file of files) {
                const filePath = `${orgSummaryDirectory}/${file}`;
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                } else {
                    fse.removeSync(filePath);
                }
            }
        };
        cleanUpDirectory();
    }
    const saveSummaryAsJson = (summaryData: OrgSummary) => {
        const jsonFilePath = `${orgSummaryDirectory}/orgsummary.json`;
        fs.writeFileSync(jsonFilePath, JSON.stringify(summaryData, null, 2), 'utf8');
        console.log(`Summary saved as: ${jsonFilePath}`);
    };
    if(outputDirectory){
        saveSummaryAsJson(summarizedOrg);
    }
}

async function checkLimits(instanceURL: string, accessToken: string): Promise<Limit[]> {
    const limits: Limit[] = [];
    const limitsApiUrl = `${instanceURL}/services/data/v50.0/limits/`;
    try {
        const limitsApiResponse = await axios.get(limitsApiUrl, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });
        const limitsData = limitsApiResponse.data;
        for (const key in limitsData) {
            if (Object.prototype.hasOwnProperty.call(limitsData, key)) {
                const limitInfo = limitsData[key];
                const description = `Description for ${key}`;
                if (limitInfo && limitInfo.Max !== undefined && limitInfo.Remaining !== undefined) {
                    limits.push({
                        Name: key,
                        Max: limitInfo.Max,
                        Remaining: limitInfo.Remaining,
                        Usage: limitInfo.Max - limitInfo.Remaining,
                        Description: description,
                    });
                } else {
                    // Handle the case where Max or Remaining is undefined
                    console.warn(`Skipping limit ${key} due to missing Max or Remaining.`);
                }
            }
        }

        return limits;
    } catch (error) {
        console.error('Error fetching limits from Salesforce API:', error.message);
    }
    return limits;
}

async function getFlowCoverageDetails(orgAlias?: string): Promise<{ Name: string; CoveragePercentage: number }[]> {
    try {
        const flowCoverage = new GetFlowCoverage();
        const flowDefinitionViews = new GetFlowDefinitionViews();

        const coverageResult = await flowCoverage.getFlowCoverage(orgAlias);
        const flowDefinitionsResult = await flowDefinitionViews.getFlowDefinitionViews(orgAlias);

        if (coverageResult?.result && flowDefinitionsResult && flowDefinitionsResult.result.records.length > 0) {
            const coverageRecords = coverageResult.result.records;
            const flowDefinitions = flowDefinitionsResult.result.records;

            return flowDefinitions.map(flowDef => {
                const matchingCoverage = coverageRecords.find(coverage => coverage.FlowVersionId === flowDef.ActiveVersionId);
                const coveragePercentage = matchingCoverage ? (matchingCoverage.NumElementsCovered / (matchingCoverage.NumElementsCovered + matchingCoverage.NumElementsNotCovered)) * 100 : 0;

                return {
                    Name: flowDef.Label,
                    CoveragePercentage: coveragePercentage,
                };
            });
        } else {
            console.error('No flow coverage or flow definition records found.');
            return [];
        }
    } catch (error) {
        console.error('Error getting flow coverage details:', error.message);
        return [];
    }
}

async function getFlowCoveragePercentage(orgAlias?: string): Promise<number> {
    try {
        const flowCoverage = new GetFlowCoverage();
        const coverageResult = await flowCoverage.getFlowCoverage(orgAlias);


        if (coverageResult?.result && coverageResult.result.records.length > 0) {
            const firstRecord = coverageResult.result.records[0];
            const totalElements = firstRecord.NumElementsCovered + firstRecord.NumElementsNotCovered;
            return totalElements > 0 ? (firstRecord.NumElementsCovered / totalElements) * 100 : 0;
        } else {
            console.error('No flow coverage records found.');
            return 0;
        }
    } catch (error) {
        console.error('Error getting flow coverage:', error.message);
        return 0;
    }
}

// Function to get details for each Apex class coverage
async function getApexClassCoverageDetails(path: string, orgAlias?: string): Promise<ApexClassCoverage[]> {
    try {
        const query = 'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate';
        const results = await queryMetadata(query, path + '/apexClassCoverageDetails.json', orgAlias);
        const coverageDetails: ApexClassCoverage[] = results.map((result: any) => ({
            Name: result['ApexClassOrTrigger.Name'] || 'N/A',
            CoveragePercentage: calculateCoveragePercentage(result.NumLinesCovered, result.NumLinesUncovered)
        }));

        return coverageDetails;
    } catch (error) {
        console.error('Error getting Apex class coverage details:', error.message);
        return [];
    }
}

function calculateComponentSummary(selectedDataPoints: string[], queryResults: { [key: string]: QueryResult[] }, errors: any[]) {
    const componentSummary: { [key: string]: ComponentSummary } = {};
    for (const dataPoint of selectedDataPoints) {
        const key = dataPoint;
        if (errors.some(error => error && error.dataPoint === dataPoint)) {
            // Skip this data point if an error occurred
            console.log(`Skipping data point '${dataPoint}' due to a previous error.`);
            continue;
        }

        if (queryResults[dataPoint]) {
            const results = queryResults[dataPoint];
            const resultLength = results.length;
            if (resultLength > 0) {
                const lastRecord = results[0];
                const lastModifiedDate = lastRecord.LastModifiedDate;
                componentSummary[key] = {
                    Total: resultLength,
                    LastModifiedDate: lastModifiedDate
                };
            }
        }
    }
    return componentSummary;
}

function calculateCoveragePercentage(linesCovered: number, linesUncovered: number): number {
    const totalLines = linesCovered + linesUncovered;
    return totalLines > 0 ? (linesCovered / totalLines) * 100 : 0;
}

function getHealthCheckScore(path: string, orgAlias?: string): HealthCheckSummary {
    let healthCheckSummary: HealthCheckSummary = { 'Score': 'N/A', 'Criteria': 'N/A', 'Risks': 'N/A', 'Compliant': 'N/A', 'Details': [] };
    let commandHCS;
    const commandHCSPath = path + '/HCS.csv';
    const commandHCRPath = path + '/HCR.csv';
    let commandHCR;
    if (orgAlias) {
        commandHCS = `sfdx data:query --query "SELECT Score FROM SecurityHealthCheck" --target-org "${orgAlias}" --result-format csv --use-tooling-api > ${commandHCSPath}`;
        commandHCR = `sfdx data:query --query "SELECT OrgValue, RiskType, Setting, SettingGroup, SettingRiskCategory FROM SecurityHealthCheckRisks" --target-org "${orgAlias}" --result-format csv --use-tooling-api > ${commandHCRPath}`;
    } else {
        commandHCS = `sfdx data:query --query "SELECT Score FROM SecurityHealthCheck" --result-format csv --use-tooling-api > ${commandHCSPath}`;
        commandHCR = `sfdx data:query --query "SELECT OrgValue, RiskType, Setting, SettingGroup, SettingRiskCategory FROM SecurityHealthCheckRisks" --result-format csv --use-tooling-api > ${commandHCSPath}`;
    }

        execSync(commandHCS, { encoding: 'utf8' });
        const hcsData = fs.readFileSync(commandHCSPath, 'utf8');
        const hcScore = parse(hcsData, { columns: true });
        execSync(commandHCR, { encoding: 'utf8' });
        const hcrData = fs.readFileSync(commandHCRPath, 'utf8');
        const hcRisks = parse(hcrData, { columns: true });
        const hcRisksFiltered = (hcRisks as HealthCheckRisk[]).filter((risk) => risk.RiskType !== 'MEETS_STANDARD');

        healthCheckSummary =
        {
            'Score': hcScore[0].Score as number,
            'Criteria': hcRisks.length,
            'Compliant': (hcRisks.length - hcRisksFiltered.length),
            'Risks': hcRisksFiltered.length,
            'Details': hcRisks
        }
        console.log('Health Check Score and Health Risks added sucessfully.');
        return healthCheckSummary;

}

function buildQuery(dataPoint: string): string {
    return `SELECT CreatedBy.Name, CreatedDate, Id, LastModifiedBy.Name, LastModifiedDate FROM ${dataPoint} ORDER BY LastModifiedDate DESC`;
}

function queryMetadata(query: string, outputCsv: string, orgAlias?: string) {
    let command;
    if (orgAlias) {
        command = `sfdx data:query --query "${query}" --target-org "${orgAlias}" --result-format csv --use-tooling-api > ${outputCsv}`;
    } else {
        command = `sfdx data:query --query "${query}" --result-format csv --use-tooling-api > ${outputCsv}`;
    }
    try {
        execSync(command);
        const csvData = fs.readFileSync(outputCsv, 'utf8');
        return parse(csvData, { columns: true });
    } catch (error) {
        handleQueryError(query, error, []);
        return [];
    }
}

function handleQueryError(dataPoint: string, error: any, errors: any[]) {
    const isUnsupportedTypeError = error.stderr.includes('sObject type') && error.stderr.includes('is not supported');
    if (isUnsupportedTypeError) {

        // todo check flag
        // Handle the specific unsupported sObject type error
        console.error(`Query for '${dataPoint}' is not supported.`);
        errors.push(null); // Push a null value to indicate a handled error
    } else {
        // Handle other errors
        console.error(`Error executing query for '${dataPoint}': ${error.message}`);
        errors.push(error);
    }
}

function extractTestRunId(jsonFilePath: string): string | null {
    try {
        const jsonData = fs.readFileSync(jsonFilePath, 'utf8');
        const regex = /-i\s*([0-9A-Za-z]{15})/;
        const match = jsonData.match(regex);
        if (match?.[1]) {
            return match[1];
        } else {
            console.error('Test run ID not found in the JSON file.');
            return null;
        }
    } catch (error) {
        console.error('Error reading JSON file:', error.message);
        return null;
    }
}

async function pollTestRunResult(jobId: string, path: string, orgAlias?: string) {
    let status = 'Queued';
    while (status === 'Queued' || status === 'Processing') {
        try {
            const query = `SELECT Id, Status FROM AsyncApexJob WHERE Id = '${jobId}' LIMIT 1`;
            // eslint-disable-next-line no-await-in-loop
            const result = await queryMetadata(query, path + '/testRunResult.json', orgAlias);
            if (result.length > 0) {
                const testJob = result[0];
                status = testJob.Status;
            } else {
                console.log('No AsyncApexJob found for the given jobId.');
            }
        } catch (error) {
            console.error('Error polling for test run result:', error.message);
            status = 'Failed';
        }
        console.log(`Test Run Status: ${status}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    return status;
}

function queryDataPoints(selectedDataPoints: string[], orgSummaryDirectory: string, orgAlias?: string | undefined) {
    const queryResults: { [key: string]: QueryResult[] } = {};
    for (const dataPoint of selectedDataPoints) {
        const query = buildQuery(dataPoint.trim());
        const result = queryMetadata(query, (orgSummaryDirectory + '/' + dataPoint.trim() + '.csv'), orgAlias);
        queryResults[dataPoint] = result instanceof Array ? result : [];
    }
    return queryResults
}

async function getTestRunDetails(jobId: string, path: string, orgAlias?: string): Promise<{ outcome: string; runtime: number; methodsCompleted: number; methodsFailed: number } | null> {
    try {
        const query = `SELECT Id, AsyncApexJobId, Status, StartTime, EndTime, TestTime, MethodsCompleted, MethodsFailed FROM ApexTestRunResult WHERE AsyncApexJobId = '${jobId}'`;
        const results = await queryMetadata(query, path + '/testRunDetails.json', orgAlias);
        if (results.length > 0) {
            const testRunResult = results[0];
            const outcome = testRunResult.Status === 'Completed' && testRunResult.MethodsFailed === 0 ? 'Pass' : 'Fail';
            const runtime = testRunResult.TestTime;
            const methodsCompleted = testRunResult.MethodsCompleted;
            const methodsFailed = testRunResult.MethodsFailed;
            console.log(`Test Run Outcome: ${outcome}, Runtime: ${runtime}s`);
            return { outcome, runtime, methodsCompleted, methodsFailed };
        } else {
            console.log('No ApexTestRunResult found for the given jobId.');
            return null;
        }
    } catch (error) {
        console.error('Error getting test run details:', error.message);
        return null;
    }
}

async function getOrgWideApexCoverage(path: string, orgAlias?: string): Promise<number | null> {
    try {
        const query = 'SELECT PercentCovered FROM ApexOrgWideCoverage';
        const results = await queryMetadata(query, path + '/orgWideApexCoverage.json', orgAlias);
        const overallCoverage = results.reduce((sum: any, result: { PercentCovered: any }) => sum + result.PercentCovered, 0) / results.length;
        return overallCoverage;
    } catch (error) {
        console.error('Error getting org-wide Apex coverage:', error.message);
        return null;
    }
}

function calculateCodeLines(): CodeDetails {

    const apexClassCL = countCodeLines('./force-app/main/default/classes', '.cls', 'apex');
    const apexTriggerCL = countCodeLines('./force-app/main/default/triggers', '.trigger', 'apex');
    const AuraDefinitionBundleCL = countCodeLines('./force-app/main/default/aura', '.js', 'javascript');
    const LightningComponentBundleCL = countCodeLines('./force-app/main/default/lwc', '.js', 'javascript');
    const StaticResourceCL = countCodeLines('./force-app/main/default/staticresources', '.js', 'javascript');
    const ApexTotal = apexClassCL.Total + apexTriggerCL.Total;
    const ApexComments = apexClassCL.Comments + apexTriggerCL.Comments;
    const ApexCode = apexClassCL.Code + apexTriggerCL.Code;
    const JavaScriptTotal = AuraDefinitionBundleCL.Total + LightningComponentBundleCL.Total + StaticResourceCL.Total;
    const JavaScriptComments = AuraDefinitionBundleCL.Comments + LightningComponentBundleCL.Comments + StaticResourceCL.Comments;
    const JavaScriptCode = AuraDefinitionBundleCL.Code + LightningComponentBundleCL.Code + StaticResourceCL.Code;

    return {
        Apex: {
            Total: ApexTotal,
            Comments: ApexComments,
            Code: ApexCode,
            Details: {
                ApexClass: apexClassCL,
                ApexTrigger: apexTriggerCL,
            },
        },
        JavaScript: {
            Total: JavaScriptTotal,
            Comments: JavaScriptComments,
            Code: JavaScriptCode,
            Details: {
                AuraDefinitionBundle: AuraDefinitionBundleCL,
                LightningComponentBundle: LightningComponentBundleCL,
                StaticResource: StaticResourceCL,
            },
        },
    };
}


interface QueryResult {
    attributes: {
        type: string;
        url: string;
    };
    CreatedBy: {
        attributes: {
            type: string;
            url: string;
        };
        Name: string;
    };
    CreatedDate: string;
    Id: string;
    LastModifiedBy: {
        attributes: {
            type: string;
            url: string;
        };
        Name: string;
    };
    LastModifiedDate: string;
}

interface OrgInfo {
    username: string;
    accessToken: string;
    instanceUrl: string;
    orgId: string;
}

function getOrgInfo(orgAlias?: string): OrgInfo {

    try {
        const command = orgAlias ? `sfdx force:org:display --verbose --json --targetusername ${orgAlias}` : 'sfdx force:org:display --verbose --json';
        const output = execSync(command, { encoding: 'utf8' });
        const orgInfo = JSON.parse(output);
        return {
            username: orgInfo.result.username,
            accessToken: orgInfo.result.accessToken,
            instanceUrl: orgInfo.result.instanceUrl,
            orgId: orgInfo.result.id
        };
    } catch (error) {
        console.error('Error getting org information:', error.message);
    }
    return {
        username: '',
        accessToken: '',
        instanceUrl: '',
        orgId: ''
    }
}

interface PreprocessedResult {
    Extension: string;
    Technology: string;
    MetadataType: string;
    Component: string;
    Row: ResultRow;
}

interface ResultRow {
    Problem: string;
    Severity: string;
    NormalizedSeverity: string;
    File: string;
    Line: string;
    Column: string;
    Rule: string;
    Description: string;
    URL: string;
    Category: string;
    Engine: string;
}

export function preprocessResults(): ProblemInfo[] {
    const scanResultsPath = './CLIScannerResults.csv';
    const results = readCsvFile(scanResultsPath);
    return results;
}

export function filterApexResults(preprocessedResults: PreprocessedResult[]): PreprocessedResult[] {
    return preprocessedResults.filter(
        (result) => result.Extension === 'cls' || result.Extension === 'trigger'
    );
}

export function filterJavaScriptResults(preprocessedResults: PreprocessedResult[]): PreprocessedResult[] {
    return preprocessedResults.filter((result) => result.Extension === 'js');
}

function readCsvFile(filePath: string): ProblemInfo[] {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');

    const headers = lines.shift()?.split(',');
    const headerNames: string[] = headers?.map(header => header.replace(/"/g, '').trim()) ?? [];

    const results: ProblemInfo[] = [];
    for (const line of lines) {
        const values = line.split(',');
        const newValues: any[] = values.map(value => value.replace(/"/g, '').trim());
        const result: ProblemInfo = {} as ProblemInfo;
        // Map values to corresponding column names
        headerNames.forEach((header, index) => {
            // Use type assertion here, assuming your values match the ProblemInfo type
            result[header as keyof ProblemInfo] = newValues[index];
        });
        results.push(result);
    }

    return results;
}

export class GetFlowCoverage {
    public async getFlowCoverage(username: string | undefined): Promise<CoverageResult> {
        const command = 'sfdx force:data:soql:query -q "SELECT Id, ApexTestClassId, ' +
            `TestMethodName, FlowVersionId, NumElementsCovered, NumElementsNotCovered FROM FlowTestCoverage" -u ${username} -t --json`;

        return this.runSFDXCommand(command) as Promise<CoverageResult>;
    }

    private runSFDXCommand(command: string): Promise<any> {
        return new Promise((resolve, reject) => {
            try {
                const result = execSync(command, { encoding: 'utf-8' });
                resolve(JSON.parse(result));
            } catch (error) {
                reject(error);
            }
        });
    }
}

export class GetFlowDefinitionViews {
    public async getFlowDefinitionViews(username: string | undefined): Promise<FlowDefinitionViewResult> {
        const command = 'sfdx force:data:soql:query -q "SELECT ApiName, InstalledPackageName, ' +
            `ActiveVersionId, Label FROM FlowDefinitionView WHERE IsActive = true" -u ${username} --json`;

        return this.runSFDXCommand(command) as Promise<FlowDefinitionViewResult>;
    }

    private runSFDXCommand(command: string): Promise<any> {
        return new Promise((resolve, reject) => {
            try {
                const result = execSync(command, { encoding: 'utf-8' });
                resolve(JSON.parse(result));
            } catch (error) {
                reject(error);
            }
        });
    }
}

export interface FlowCoverageRecord {
    type: string;
    url: string;
    Id: string;
    ApexTestClassId: string;
    TestMethodName: string;
    FlowVersionId: string;
    NumElementsCovered: number;
    NumElementsNotCovered: number;
}

export interface CoverageResult {
    status: number;
    result: {
        done: boolean;
        totalSize: number;
        records: FlowCoverageRecord[];
    };
}

export interface FlowDefinitionViewRecord {
    attributes: {
        type: string;
        url: string;
    };
    ApiName: string;
    InstalledPackageName: string;
    ActiveVersionId: string;
    Label: string;
}

export interface FlowDefinitionViewResult {
    status: number;
    result: {
        done: boolean;
        totalSize: number;
        records: FlowDefinitionViewRecord[];
    };
}

export type OrgSummary = {
    DateOfSummary: string;
    Timestamp: string;
    ResultState: string;
    OrgId: string;
    OrgInstanceURL: string;
    Username: string;
  } & Partial<{
    OutputPath: string;
    Metadata: { [key: string]: ComponentSummary };
    Code: CodeAnalysis;
    HealthCheck: HealthCheckSummary;
    Limits: LimitSummary;
    Tests: TestSummary;
  }>;