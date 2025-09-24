// app.js (Complete updated without PM2, realtime logs and status)
const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
const server = http.createServer(app);

const { Server } = require("socket.io");
const io = new Server(server);

const PORT = process.env.PORT || 3001;
const PROJECTS_BASE_PATH = path.join(__dirname, 'deployments');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));

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
        fs.rmdirSync(project.path, { recursive: true });
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

app.use('/:projectName', (req, res, next) => {
    const projectName = req.params.projectName;
    const mainRoutes = ['', 'deploy', 'webhook', 'project', 'delete-project', 'projectName'];
    if (mainRoutes.includes(projectName)) {
        return next();
    }
    const projectPath = path.join(PROJECTS_BASE_PATH, projectName);
    if (fs.existsSync(projectPath)) {
        express.static(projectPath)(req, res, next);
    } else {
        res.status(404).send('Project not found');
    }
});

io.on('connection', (socket) => {
    socket.on('joinProjectRoom', (projectName) => {
        socket.join(projectName);
    });
});

let projects = [];

function executeCommand(command, args, cwd, project) {
    return new Promise((resolve, reject) => {
        try {
            const cmd = spawn(command, args, { cwd, shell: true });

            cmd.stdout.on('data', (data) => {
                const logMessage = data.toString();
                project.logs += logMessage;
                io.to(project.name).emit('logUpdate', logMessage);
                console.log(logMessage.trim());
            });

            cmd.stderr.on('data', (data) => {
                const logMessage = `ERROR: ${data.toString()}`;
                project.logs += logMessage;
                io.to(project.name).emit('logUpdate', logMessage);
                console.error(logMessage.trim());
            });

            cmd.on('close', (code) => {
                if (code !== 0) {
                    const errorMessage = `Exited with status ${code}\n`;
                    project.logs += errorMessage;
                    io.to(project.name).emit('logUpdate', errorMessage);
                    reject(new Error(errorMessage));
                } else {
                    resolve();
                }
            });
        } catch (error) {
            const errorMessage = `Command failed to start: ${error.message}\n`;
            project.logs += errorMessage;
            io.to(project.name).emit('logUpdate', errorMessage);
            reject(new Error(errorMessage));
        }
    });
}

async function deployProject(project) {
    const projectPath = path.join(PROJECTS_BASE_PATH, project.name);
    project.path = projectPath;

    try {
        if (!fs.existsSync(PROJECTS_BASE_PATH)) {
            fs.mkdirSync(PROJECTS_BASE_PATH);
        }

        project.status = 'Cloning';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs = 'Cloning ' + project.repoUrl + '...\n';
        io.to(project.name).emit('logUpdate', project.logs);
        await executeCommand('git', ['clone', project.repoUrl, project.name], PROJECTS_BASE_PATH, project);

        project.status = 'Building';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += '\nRunning build command: ' + project.buildCommand + '\n';
        io.to(project.name).emit('logUpdate', '\nRunning build command: ' + project.buildCommand + '\n');
        await executeCommand(project.buildCommand, [], projectPath, project);

        project.status = 'Starting';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += '\nRunning start command: ' + project.startCommand + '\n';
        io.to(project.name).emit('logUpdate', '\nRunning start command: ' + project.startCommand + '\n');

        const childProcess = spawn(project.startCommand, [], { cwd: projectPath, shell: true });

        childProcess.stdout.on('data', (data) => {
            const logMessage = data.toString();
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
        });

        childProcess.stderr.on('data', (data) => {
            const logMessage = `ERROR: ${data.toString()}`;
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
        });

        childProcess.on('close', (code) => {
            if (code !== 0) {
                const errorMessage = `Start command exited with status ${code}\n`;
                project.logs += errorMessage;
                io.to(project.name).emit('logUpdate', errorMessage);
                project.status = 'Error';
                io.to(project.name).emit('statusUpdate', project.status);
            }
        });

        project.status = 'LIVE';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += `\nProject ${project.name} is now LIVE.\n`;
        io.to(project.name).emit('logUpdate', `\nProject ${project.name} is now LIVE.\n`);

        project.url = `http://yourdomain.com/${project.name}`;
    } catch (error) {
        project.status = 'Error';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += `\nERROR: ${error.message}\n`;
        io.to(project.name).emit('logUpdate', `\nERROR: ${error.message}\n`);
    }
}

async function updateProject(project) {
    const projectPath = path.join(PROJECTS_BASE_PATH, project.name);
    if (!fs.existsSync(projectPath)) {
        project.logs += 'Directory not found. Please deploy first.\n';
        io.to(project.name).emit('logUpdate', 'Directory not found. Please deploy first.\n');
        return;
    }

    project.status = 'Updating';
    io.to(project.name).emit('statusUpdate', project.status);
    project.logs += 'Updating ' + project.name + ' from GitHub...\n';
    io.to(project.name).emit('logUpdate', 'Updating ' + project.name + ' from GitHub...\n');

    try {
        await executeCommand('git', ['pull'], projectPath, project);

        project.status = 'Building';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += '\nRe-running build command: ' + project.buildCommand + '\n';
        io.to(project.name).emit('logUpdate', '\nRe-running build command: ' + project.buildCommand + '\n');
        await executeCommand(project.buildCommand, [], projectPath, project);

        project.status = 'Restarting';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += '\nRunning start command: ' + project.startCommand + '\n';
        io.to(project.name).emit('logUpdate', '\nRunning start command: ' + project.startCommand + '\n');

        const childProcess = spawn(project.startCommand, [], { cwd: projectPath, shell: true });

        childProcess.stdout.on('data', (data) => {
            const logMessage = data.toString();
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
        });

        childProcess.stderr.on('data', (data) => {
            const logMessage = `ERROR: ${data.toString()}`;
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
        });

        childProcess.on('close', (code) => {
            if (code !== 0) {
                const errorMessage = `Start command exited with status ${code}\n`;
                project.logs += errorMessage;
                io.to(project.name).emit('logUpdate', errorMessage);
                project.status = 'Error';
                io.to(project.name).emit('statusUpdate', project.status);
            }
        });

        project.status = 'LIVE';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += '\nProject ' + project.name + ' is now LIVE.\n';
        io.to(project.name).emit('logUpdate', '\nProject ' + project.name + ' is now LIVE.\n');
    } catch (error) {
        project.status = 'Error';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += `\nERROR: ${error.message}\n`;
        io.to(project.name).emit('logUpdate', `\nERROR: ${error.message}\n`);
    }
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
