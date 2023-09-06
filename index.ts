import * as pulumi from "@pulumi/pulumi";
import * as eks from "@pulumi/eks";
import * as awsx from "@pulumi/awsx";
import * as kubernetes from "@pulumi/kubernetes";

// Create a VPC for our cluster.
const vpc = new awsx.ec2.Vpc("prometheus-grafana", {});

// Create an EKS cluster inside of the VPC.
const cluster = new eks.Cluster("cluster", {
    vpcId: vpc.vpcId,
    publicSubnetIds: vpc.publicSubnetIds,
    privateSubnetIds: vpc.privateSubnetIds,
    nodeAssociatePublicIpAddress: false,
});

const eksProvider = new kubernetes.Provider("eks-provider", {kubeconfig: cluster.kubeconfigJson});

const grafanaNamespace = new kubernetes.core.v1.Namespace("grafana", {
    metadata: {
        name: "grafana",
    },
}, { provider: eksProvider });

const prometheusNamespace = new kubernetes.core.v1.Namespace("prometheus", {
    metadata: {
        name: "prometheus",
    },
}, { provider: eksProvider });

// Deploy a small canary service (NGINX), to test that the cluster is working.
new kubernetes.apps.v1.Deployment("nginx-deployment", {
    metadata: {
        labels: {
            appClass: "nginx-deployment",
        },
    },
    spec: {
        replicas: 2,
        selector: {
            matchLabels: {
                appClass: "nginx-deployment",
            },
        },
        template: {
            metadata: {
                labels: {
                    appClass: "nginx-deployment",
                },
            },
            spec: {
                containers: [{
                    name: "nginx-deployment",
                    image: "nginx",
                    ports: [{
                        name: "http",
                        containerPort: 80,
                    }],
                }],
            },
        },
    },
}, {
    provider: eksProvider,
});

const myService = new kubernetes.core.v1.Service("nginx-service", {
    metadata: {
        labels: {
            appClass: "nginx-deployment",
        },
    },
    spec: {
        type: "LoadBalancer",
        ports: [{
            port: 80,
            targetPort: "http",
        }],
        selector: {
            appClass: "nginx-deployment",
        },
    },
}, {
    provider: eksProvider,
});

// Deploy Prometheus using Helm
const prometheus = new kubernetes.helm.v3.Chart("prometheus", {
    namespace: prometheusNamespace.metadata.name,
    chart: "kube-prometheus",
    version: "8.17.1",
    fetchOpts: {
        repo: "https://charts.bitnami.com/bitnami",
    }
}, { provider: eksProvider });

const prometheusService = new kubernetes.core.v1.Service("prometheus-service", {
    metadata: { namespace: prometheusNamespace.metadata.name },
    spec: {
        type: "LoadBalancer",
        selector: {
            "app.kubernetes.io/name": "prometheus",
            "prometheus": "prometheus-kube-prometheus-prometheus",
        },
        ports: [
            {
                name: "http",
                port: 9090,
                targetPort: 9090,
                protocol: "TCP",
            },
        ],
    },
}, { provider: eksProvider });

// Deploy Grafana using Helm
const grafana = new kubernetes.helm.v3.Chart("grafana", {
    namespace: grafanaNamespace.metadata.name,
    chart: "grafana",
    fetchOpts: {
        repo: "https://grafana.github.io/helm-charts",
    },
    values: {
        adminPassword: "adminPass"
    }
}, { provider: eksProvider });

const grafanaService = new kubernetes.core.v1.Service("grafana-service", {
    metadata: { namespace: grafanaNamespace.metadata.name },
    spec: {
        type: "LoadBalancer",
        selector: {
            "app.kubernetes.io/instance": "grafana",
            "app.kubernetes.io/name": "grafana"
        },
        ports: [
            {
                name: "http",
                port: 80,
                targetPort: 3000,
                protocol: "TCP",
            },
        ],
    },
}, { provider: eksProvider });

// Export the LoadBalancer's URL for Prometheus and Grafana
export const prometheusUrl = pulumi.interpolate`http://${prometheusService.status.loadBalancer.ingress[0].hostname}:9090`;
export const grafanaUrl = pulumi.interpolate`http://${grafanaService.status.loadBalancer.ingress[0].hostname}:80`;

// Export the cluster's kubeconfig.
export const kubeconfig = cluster.kubeconfig;
export const eksClusterName = cluster.eksCluster.name;

export const prometheusLocalUrl = pulumi.interpolate`http://${prometheusService.spec.clusterIP}:9090`;

// Export the URL for the Nginx service.
export const nginxUrl = myService.status.apply(status => status?.loadBalancer?.ingress[0]?.hostname);