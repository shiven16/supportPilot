output "alb_hostname" {
  description = "The DNS name of the ALB"
  value       = aws_lb.main.dns_name
}

output "ecr_repository_url" {
  description = "The URL of the ECR repository"
  value       = aws_ecr_repository.app.repository_url
}

output "cloudfront_https_url" {
  description = "The HTTPS URL provided by CloudFront to use in your Slack App Manifest"
  value       = "https://${aws_cloudfront_distribution.alb_proxy.domain_name}"
}
