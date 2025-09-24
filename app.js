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
app.use('/projects', express.static(PROJECTS_BASE_PATH));

let projects = [];
const USED_PORTS = new Set();

// Helper function to find an available port
function findAvailablePort() {
    let port = 4000;
    while(USED_PORTS.has(port)) {
        port++;
    }
    USED_PORTS.add(port);
    return port;
}

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
        
        // Find a free port for the app
        project.port = findAvailablePort();

        project.status = 'Building';
        project.logs += '\nRunning build command: ' + project.buildCommand + '\n';
        await executeCommand(project.buildCommand, [], projectPath, { write: (data) => project.logs += data });

        project.status = 'Starting';
        project.logs += '\nStarting app with PM2: ' + project.startCommand + ' on port ' + project.port + '\n';
        // Pass the port as an environment variable
        await executeCommand(`PORT=${project.port} pm2 start --name ${project.name} -- ${project.startCommand}`, [], projectPath, { write: (data) => project.logs += data });

        project.status = 'LIVE';
        project.logs += `\nProject ${project.name} is now LIVE.\n`;
        project.url = `http://localhost:${project.port}`;
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

app.get('/project/add', (req, res) => {
    res.render('add-project');
});

app.get('/project/:projectName', (req, res) => {
    const project = projects.find(p => p.name === req.params.projectName);
    if (!project) {
        return res.status(404).send('Project not found.');
    }
    res.render('project', { project });
});

app.post('/deploy', (req, res) => {
    const { projectName, repoUrl, buildCommand, startCommand } = req.body;
    const existingProject = projects.find(p => p.name === projectName);
    if (existingProject) {
        return res.status(400).send('Project with this name already exists.');
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

app.post('/delete-project', async (req, res) => {
    const { projectName } = req.body;
    const projectIndex = projects.findIndex(p => p.name === projectName);

    if (projectIndex === -1) {
        return res.status(404).send('Project not found.');
    }

    const project = projects[projectIndex];
    try {
        await executeCommand('pm2', ['delete', projectName], project.path, { write: (data) => project.logs += data });
        fs.rmdirSync(project.path, { recursive: true });
        USED_PORTS.delete(project.port);
        projects.splice(projectIndex, 1);
        res.redirect('/');
    } catch (error) {
        res.status(500).send('Failed to delete project.');
    }
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

