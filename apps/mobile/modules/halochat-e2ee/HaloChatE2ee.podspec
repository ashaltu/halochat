Pod::Spec.new do |s|
  s.name           = 'HaloChatE2ee'
  s.version        = '0.1.0'
  s.summary        = 'HaloChat native MLS encryption module'
  s.description    = 'Native Expo bridge for the HaloChat Rust MLS core.'
  s.license        = { :type => 'BSD-3-Clause' }
  s.author         = 'HaloChat'
  s.homepage       = 'https://localhost/halochat-e2ee'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.vendored_frameworks = 'ios/halochat_e2ee_coreFFI.xcframework'
  s.source_files = 'ios/*.swift', 'ios/generated/*.swift'
  s.dependency 'ExpoModulesCore'
end
