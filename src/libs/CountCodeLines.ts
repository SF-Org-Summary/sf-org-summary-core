import fs = require('fs');

export function countCodeLines(directory: string, extension: string, language: 'apex' | 'javascript'): { Total: number; Comments: number; Code: number } {
  const codeFiles = getAllFiles(directory, extension);
  let commentLines = 0;
  let totalLines = 0;

  codeFiles.forEach(filePath => {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    let comments = [];
    if (language === 'apex') {
      comments = fileContent.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
    } else if (language === 'javascript') {
      comments = fileContent.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
    }
    const total = fileContent.split('\n').filter(line => line.trim() !== '').length;
    commentLines += comments.length;
    totalLines += total;
  });

  return {
    Total: totalLines,
    Comments: commentLines,
    Code: totalLines - commentLines
  };
}

function getAllFiles(directory: string, extension: string): string[] {
  const files: string[] = [];
  const dirents = fs.readdirSync(directory, { withFileTypes: true });

  for (const dirent of dirents) {
    const fullPath = `${directory}/${dirent.name}`;
    if (dirent.isDirectory()) {
      files.push(...getAllFiles(fullPath, extension));
    } else if (dirent.isFile() && dirent.name.endsWith(extension)) {
      files.push(fullPath);
    }
  }

  return files;
}