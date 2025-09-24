const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const PROJECTS_BASE_PATH = path.join(__dirname, 'deployments');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/projects', express.static(PROJECTS_BASE_PATH)); // Serve static files from the deployments directory

let projects = [];

// Helper function to execute shell commands and stream logs
function executeCommand(command, args, cwd, logStream) {
    return new Promise((resolve, reject) => {
        try {
            const cmd = spawn(command, args, { cwd, shell: true });

            cmd.stdout.on('data', (data) => {
                const logMessage = data.toString();
                logStream.write(logMessage);
                console.log(logMessage.trim()); // Console mein bhi log karein
            });

            cmd.stderr.on('data', (data) => {
                const logMessage = `ERROR: ${data.toString()}`;
                logStream.write(logMessage);
                console.error(logMessage.trim()); // Console mein error log karein
            });

            cmd.on('close', (code) => {
                if (code !== 0) {
                    const errorMessage = `Exited with status ${code}`;
                    logStream.write(errorMessage);
                    console.error(errorMessage);
                    return reject(new Error(errorMessage));
                }
                resolve();
            });
        } catch (error) {
            const errorMessage = `Command failed to start: ${error.message}`;
            logStream.write(errorMessage);
            console.error(errorMessage);
            reject(new Error(errorMessage));
        }
    });
}

// Deploy a new project
async function deployProject(project) {
    const projectPath = path.join(PROJECTS_BASE_PATH, project.name);
    project.path = projectPath;

    try {
        if (!fs.existsSync(PROJECTS_BASE_PATH)) {
            fs.mkdirSync(PROJECTS_BASE_PATH);
        }

        project.status = 'Cloning';
        project.logs = 'Cloning ' + project.repoUrl + '...\n';
        await executeCommand('git', ['clone', project.repoUrl, project.name], PROJECTS_BASE_PATH, { write: (data) => project.logs += data });

        project.status = 'Building';
        project.logs += '\nRunning build command: ' + project.buildCommand + '\n';
        await executeCommand(project.buildCommand, [], projectPath, { write: (data) => project.logs += data });

        project.status = 'Starting';
        project.logs += '\nStarting app with PM2: ' + project.startCommand + '\n';
        await executeCommand(`pm2 start --name ${project.name} ${project.startCommand}`, [], projectPath, { write: (data) => project.logs += data });

        project.status = 'LIVE';
        project.logs += `\nProject ${project.name} is now LIVE.\n`;
        project.url = `/projects/${project.name}`;
    } catch (error) {
        project.status = 'Error';
        project.logs += `\nERROR: ${error.message}\n`;
    }
}

// Update an existing project
async function updateProject(project) {
    const projectPath = path.join(PROJECTS_BASE_PATH, project.name);

    if (!fs.existsSync(projectPath)) {
        project.logs += 'Directory not found. Please deploy first.\n';
        return;
    }

    project.status = 'Updating';
    project.logs += 'Updating ' + project.name + ' from GitHub...\n';

    try {
        await executeCommand('git', ['pull'], projectPath, { write: (data) => project.logs += data });
        
        project.status = 'Building';
        project.logs += '\nRe-running build command: ' + project.buildCommand + '\n';
        await executeCommand(project.buildCommand, [], projectPath, { write: (data) => project.logs += data });

        project.status = 'Restarting';
        project.logs += '\nRestarting app with PM2...\n';
        await executeCommand('pm2', ['restart', project.name], projectPath, { write: (data) => project.logs += data });

        project.status = 'LIVE';
        project.logs += '\nProject ' + project.name + ' is now LIVE.\n';
    } catch (error) {
        project.status = 'Error';
        project.logs += `\nERROR: ${error.message}\n`;
    }
}

// Routes
app.get('/', (req, res) => {
    res.render('index', { projects });
});

app.post('/deploy', (req, res) => {
    const { projectName, repoUrl, buildCommand, startCommand } = req.body;
    const existingProject = projects.find(p => p.name === projectName);
    if (existingProject) {
        res.status(400).send('Project with this name already exists.');
        return;
    }

    const newProject = {
        name: projectName,
        repoUrl,
        buildCommand,
        startCommand,
        status: 'Pending',
        logs: '',
        path: '',
        url: ''
    };
    projects.push(newProject);
    res.redirect('/');
    deployProject(newProject);
});

app.post('/webhook', (req, res) => {
    const repoUrl = req.body.repository.html_url;
    const projectToUpdate = projects.find(p => p.repoUrl === repoUrl);

    if (projectToUpdate) {
        updateProject(projectToUpdate);
        res.status(200).send('Webhook received and update triggered.');
    } else {
        res.status(404).send('Project not found for this repository.');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

