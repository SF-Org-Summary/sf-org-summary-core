# Salesforce Org Summarizer

## Overview

Salesforce Org Summarizer is a tool designed to provide a comprehensive summary of your Salesforce org, including information about components, code analysis, health checks, limits, and tests. The tool leverages Salesforce CLI and various APIs to gather data and generate a detailed summary.

## Table of Contents

- [Usage](#usage)
- [Flags](#flags)
- [Examples](#examples)
- [Output](#output)

## Usage

To generate a summary of your Salesforce org, use the following function:
```
summarizeOrg(orgAlias: string, baseSummary?: OrgSummary)
```

## Flags:

| Flag | Description | Optional |
|------|-------------|----------|
| `-o`, `--outputdirectory` | Output directory for the summary | Yes |
| `-c`, `--components` | Components to process (comma-separated) | Yes |
| `-k`, `--keepdata` | Keep raw query data files | Yes |
| `-h`, `--healthcheck` | Enable Health Check analysis | Yes |
| `-l`, `--limits` | Enable Org Limits check | Yes |
| `-a`, `--codeanalysis` | Enable Code Analysis | Yes |
| `-t`, `--tests` | Enable Apex tests | Yes |
| `-u`, `--targetusername` | Alias or username of the target org | Yes |


## Output:

The tool generates a detailed summary that includes information about components, code analysis, health checks, limits, and tests. The summary is saved as a JSON file in the specified output directory, or in case this is not provided, the current directory.   